//! Port of `electron/core/desktop-wipe.ts`.
//!
//! When Claude Desktop last finished its draft wipe, read from the LevelDB log of its live
//! Local Storage. claude.ai stamps `chat-draft-wipe-completed-at` (ms since the epoch) once it
//! has removed the drafts after an account change, about 2–6 s after Claude starts. Relay only
//! reads: no copy, no lock, nothing written, and no key but that one is looked at.

use std::fs;
use std::path::Path;

/// The marker's LevelDB key: Chromium's `_<origin>\0\x01<key>`, the key in Latin-1.
const WIPE_KEY: &[u8] = b"_https://claude.ai\x00\x01chat-draft-wipe-completed-at";
/// A log larger than this is not Local Storage's write-ahead log as Relay knows it.
const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;
const BLOCK: usize = 32 * 1024;
const HEADER: usize = 7;
const FULL: u8 = 1;
const FIRST: u8 = 2;
const MIDDLE: u8 = 3;
const LAST: u8 = 4;
const PUT: u8 = 1;
const DELETE: u8 = 0;

/// A write of the marker: its time (None for a delete or a value that is no time) and the
/// LevelDB sequence number it was written at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WipeMarker {
    pub at: Option<f64>,
    pub sequence: u64,
}

/// A varint32 at `at`, and where the bytes after it start; None past the end.
fn varint(bytes: &[u8], at: usize) -> Option<(usize, usize)> {
    let mut value: u32 = 0;
    let mut shift = 0;
    let mut i = at;
    while i < bytes.len() && shift <= 28 {
        let byte = bytes[i];
        // JS's 32-bit `|=` and `<<`: bits shifted past 32 are lost.
        value |= u32::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some((value as usize, i + 1));
        }
        shift += 7;
        i += 1;
    }
    None
}

/// The records of a LevelDB log: 32 KiB blocks of chunks, each a 7-byte header (checksum,
/// length, type) and its bytes, a record split over blocks as FIRST, MIDDLE… and LAST. A torn
/// tail, as when Chromium is writing it, ends the list; a chunk out of order drops its record.
fn log_records(log: &[u8]) -> Vec<Vec<u8>> {
    let mut records = Vec::new();
    let mut parts: Option<Vec<u8>> = None;
    let mut at = 0;
    while at + HEADER <= log.len() {
        let left = BLOCK - (at % BLOCK);
        if left < HEADER {
            at += left;
            continue;
        }
        let length = usize::from(u16::from_le_bytes([log[at + 4], log[at + 5]]));
        let kind = log[at + 6];
        let start = at + HEADER;
        if kind == 0 && length == 0 {
            // Zero padding: the rest of the block is empty.
            at += left;
            continue;
        }
        if start + length > log.len() || HEADER + length > left {
            break;
        }
        let chunk = &log[start..start + length];
        at = start + length;
        match kind {
            FULL => {
                parts = None;
                records.push(chunk.to_vec());
            }
            FIRST => parts = Some(chunk.to_vec()),
            MIDDLE if parts.is_some() => {
                if let Some(parts) = parts.as_mut() {
                    parts.extend_from_slice(chunk);
                }
            }
            LAST if parts.is_some() => {
                if let Some(mut whole) = parts.take() {
                    whole.extend_from_slice(chunk);
                    records.push(whole);
                }
            }
            _ => parts = None,
        }
    }
    records
}

/// A Local Storage value as a string: 0x01 then Latin-1, or 0x00 then UTF-16LE.
fn storage_string(value: &[u8]) -> Option<String> {
    match value.first() {
        Some(1) => Some(value[1..].iter().map(|&b| char::from(b)).collect()),
        Some(0) if value.len() % 2 == 1 => Some(
            char::decode_utf16(
                value[1..]
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]])),
            )
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect(),
        ),
        _ => None,
    }
}

/// `/^\d{1,16}$/` then `Number(text)`.
fn stamp(text: &str) -> Option<f64> {
    (!text.is_empty() && text.len() <= 16 && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse::<f64>().ok())
        .flatten()
}

/// The marker's newest value in `log`, by sequence number, with its sequence: a write batch is
/// an 8-byte sequence, a 4-byte count, then puts (tag 1, key, value) and deletes (tag 0, key),
/// each entry one sequence number after the last. A delete newer than every put wins as
/// `at: None`. A batch that does not parse is skipped whole.
pub fn wipe_marker_in(log: &[u8]) -> Option<WipeMarker> {
    let mut newest: Option<WipeMarker> = None;
    for batch in log_records(log) {
        if batch.len() < 12 {
            continue;
        }
        let first = u64::from_le_bytes(batch[0..8].try_into().unwrap_or_default());
        let count = u32::from_le_bytes(batch[8..12].try_into().unwrap_or_default());
        let mut found = Vec::new();
        let mut at = 12;
        let mut ok = true;
        for n in 0..count {
            let tag = batch.get(at).copied();
            at += 1;
            let key = varint(&batch, at);
            let (Some(tag @ (PUT | DELETE)), Some((key_length, key_start))) = (tag, key) else {
                ok = false;
                break;
            };
            let key_end = key_start + key_length;
            if key_end > batch.len() {
                ok = false;
                break;
            }
            let is_marker = &batch[key_start..key_end] == WIPE_KEY;
            at = key_end;
            let mut value = None;
            if tag == PUT {
                let Some((length, start)) = varint(&batch, at) else {
                    ok = false;
                    break;
                };
                if start + length > batch.len() {
                    ok = false;
                    break;
                }
                value = Some(&batch[start..start + length]);
                at = start + length;
            }
            if !is_marker {
                continue;
            }
            let at = value.and_then(storage_string).as_deref().and_then(stamp);
            found.push(WipeMarker {
                at,
                sequence: first.wrapping_add(u64::from(n)),
            });
        }
        if !ok {
            continue;
        }
        for entry in found {
            if newest.is_none_or(|newest| entry.sequence > newest.sequence) {
                newest = Some(entry);
            }
        }
    }
    newest
}

/// `/^\d+\.log$/`.
fn is_log_name(name: &str) -> bool {
    name.strip_suffix(".log")
        .is_some_and(|stem| !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()))
}

/// The newest `chat-draft-wipe-completed-at` in the `.log` files of `leveldb`, Claude's
/// `Local Storage/leveldb` folder; None when none holds it, as once LevelDB has moved it
/// into a table, or when the folder cannot be read. Never fails.
pub fn last_draft_wipe_at(leveldb: &Path) -> Option<f64> {
    let names: Vec<String> = fs::read_dir(leveldb)
        .ok()?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| is_log_name(name))
        .collect();
    let mut newest: Option<WipeMarker> = None;
    for name in names {
        // A log LevelDB removed meanwhile, or one that cannot be read: the others still count.
        let file = leveldb.join(name);
        let Ok(meta) = fs::metadata(&file) else {
            continue;
        };
        if meta.len() > MAX_LOG_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&file) else { continue };
        if let Some(marker) = wipe_marker_in(&bytes)
            && newest.is_none_or(|newest| marker.sequence > newest.sequence)
        {
            newest = Some(marker);
        }
    }
    newest?.at
}
