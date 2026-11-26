//! Port of tests/desktop-wipe.test.ts.

use std::fs;

use relay_core::desktop_wipe::{WipeMarker, last_draft_wipe_at, wipe_marker_in};

const BLOCK: usize = 32 * 1024;
const HEADER: usize = 7;
const MARKER: &str = "chat-draft-wipe-completed-at";

fn latin1_bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u8).collect()
}

/// Chromium's Local Storage key: `_<origin>\0\x01<key>`.
fn key_in(name: &str, origin: &str) -> Vec<u8> {
    latin1_bytes(&format!("_{origin}\u{0}\u{1}{name}"))
}

fn key(name: &str) -> Vec<u8> {
    key_in(name, "https://claude.ai")
}

/// A Local Storage string: 0x01 then Latin-1, or 0x00 then UTF-16LE.
fn latin1(text: &str) -> Vec<u8> {
    let mut out = vec![1];
    out.extend(latin1_bytes(text));
    out
}

fn utf16(text: &str) -> Vec<u8> {
    let mut out = vec![0];
    for unit in text.encode_utf16() {
        out.extend(unit.to_le_bytes());
    }
    out
}

fn varint(mut n: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    while n >= 0x80 {
        bytes.push(((n & 0x7f) | 0x80) as u8);
        n >>= 7;
    }
    bytes.push(n as u8);
    bytes
}

/// A write batch: its first sequence, then puts (key and value) and deletes (key alone).
fn batch(sequence: u64, entries: &[(Vec<u8>, Option<Vec<u8>>)]) -> Vec<u8> {
    let mut out = sequence.to_le_bytes().to_vec();
    out.extend((entries.len() as u32).to_le_bytes());
    for (k, v) in entries {
        out.push(u8::from(v.is_some()));
        out.extend(varint(k.len()));
        out.extend(k);
        if let Some(v) = v {
            out.extend(varint(v.len()));
            out.extend(v);
        }
    }
    out
}

fn put(k: Vec<u8>, v: Vec<u8>) -> (Vec<u8>, Option<Vec<u8>>) {
    (k, Some(v))
}

/// A LevelDB log of `records`, as LevelDB writes it: 32 KiB blocks, a record that does not fit
/// split into FIRST, MIDDLE… LAST chunks, and a block's last bytes too few for a header left
/// as zeros. The checksums are zero; the reader does not need them.
fn log(records: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for record in records {
        let mut at = 0;
        let mut first = true;
        loop {
            let left = BLOCK - (out.len() % BLOCK);
            if left < HEADER {
                out.extend(vec![0; left]);
                if at < record.len() {
                    continue;
                }
                break;
            }
            let room = left - HEADER;
            let length = room.min(record.len() - at);
            let end = at + length == record.len();
            let kind = match (first, end) {
                (true, true) => 1,
                (true, false) => 2,
                (false, true) => 4,
                (false, false) => 3,
            };
            let mut header = [0u8; HEADER];
            header[4..6].copy_from_slice(&(length as u16).to_le_bytes());
            header[6] = kind;
            out.extend(header);
            out.extend(&record[at..at + length]);
            at += length;
            first = false;
            if at >= record.len() {
                break;
            }
        }
    }
    out
}

#[test]
fn the_marker_s_value_is_read_from_a_write_batch_among_other_keys() {
    let bytes = log(&[batch(
        10,
        &[
            put(key("chat-draft-wipe-started-at"), latin1("1792400847552")),
            put(key(MARKER), latin1("1792400847786")),
            put(
                key("composer-draft:epitaxy-local_x"),
                latin1("never looked at"),
            ),
        ],
    )]);
    assert_eq!(
        wipe_marker_in(&bytes),
        Some(WipeMarker {
            at: Some(1792400847786.0),
            sequence: 11
        })
    );
    // A UTF-16 value reads the same.
    assert_eq!(
        wipe_marker_in(&log(&[batch(
            3,
            &[put(key(MARKER), utf16("1792400847786"))]
        )]))
        .and_then(|m| m.at),
        Some(1792400847786.0)
    );
}

#[test]
fn the_newest_write_of_the_marker_wins_by_sequence_number_and_a_delete_after_it_leaves_none() {
    let two = log(&[
        batch(50, &[put(key(MARKER), latin1("2000"))]),
        batch(40, &[put(key(MARKER), latin1("1000"))]),
    ]);
    assert_eq!(wipe_marker_in(&two).and_then(|m| m.at), Some(2000.0));
    let deleted = log(&[
        batch(50, &[put(key(MARKER), latin1("2000"))]),
        batch(60, &[(key(MARKER), None)]),
    ]);
    assert_eq!(
        wipe_marker_in(&deleted),
        Some(WipeMarker {
            at: None,
            sequence: 60
        })
    );
}

#[test]
fn another_origin_another_key_or_no_marker_at_all_is_no_marker() {
    assert_eq!(
        wipe_marker_in(&log(&[batch(
            1,
            &[
                put(key_in(MARKER, "https://example.com"), latin1("5")),
                put(key("chat-draft-wipe-completed-id"), latin1("x@5")),
                put(latin1_bytes(MARKER), latin1("5")),
            ],
        )])),
        None
    );
    assert_eq!(wipe_marker_in(&[]), None);
}

#[test]
fn a_marker_in_a_record_split_over_blocks_is_found() {
    // A large value first, so the batch runs over two blocks and the marker sits in the second.
    let big = latin1(&"y".repeat(BLOCK + 500));
    let bytes = log(&[
        batch(7, &[put(key("LSS-something"), big)]),
        batch(
            9,
            &[
                put(key("filler"), latin1(&"z".repeat(BLOCK))),
                put(key(MARKER), latin1("123456")),
            ],
        ),
    ]);
    assert!(bytes.len() > 2 * BLOCK);
    assert_eq!(
        wipe_marker_in(&bytes),
        Some(WipeMarker {
            at: Some(123456.0),
            sequence: 10
        })
    );
}

#[test]
fn a_torn_last_record_a_broken_batch_or_a_value_that_is_no_time_is_skipped() {
    let whole = log(&[batch(1, &[put(key(MARKER), latin1("1000"))])]);
    let torn = log(&[
        batch(1, &[put(key(MARKER), latin1("1000"))]),
        batch(2, &[put(key(MARKER), latin1("2000"))]),
    ]);
    // Chromium is still writing the second record.
    assert_eq!(
        wipe_marker_in(&torn[..torn.len() - 3]).and_then(|m| m.at),
        Some(1000.0)
    );
    // A batch claiming more entries than it holds is dropped whole.
    let mut broken = batch(5, &[put(key(MARKER), latin1("5000"))]);
    broken[8..12].copy_from_slice(&3u32.to_le_bytes());
    assert_eq!(wipe_marker_in(&log(std::slice::from_ref(&broken))), None);
    assert_eq!(
        wipe_marker_in(&log(&[
            batch(1, &[put(key(MARKER), latin1("1000"))]),
            broken
        ]))
        .and_then(|m| m.at),
        Some(1000.0)
    );
    // A value that is not a time counts as a write of no time.
    assert_eq!(
        wipe_marker_in(&log(&[batch(4, &[put(key(MARKER), latin1("soon"))])])),
        Some(WipeMarker {
            at: None,
            sequence: 4
        })
    );
    // Zero padding, as at the end of a block, is read past.
    let mut padded = whole.clone();
    padded.resize(BLOCK, 0);
    assert_eq!(wipe_marker_in(&padded).and_then(|m| m.at), Some(1000.0));
}

#[test]
fn the_folder_s_log_files_are_read_the_newest_marker_of_all_wins_and_nothing_else_counts() {
    let scratch = tempfile::Builder::new()
        .prefix("relay-wipe-")
        .tempdir()
        .unwrap();
    let leveldb = scratch.path().join("leveldb");
    fs::create_dir(&leveldb).unwrap();
    assert_eq!(last_draft_wipe_at(&leveldb), None);
    let write = |name: &str, sequence: u64, value: &str| {
        fs::write(
            leveldb.join(name),
            log(&[batch(sequence, &[put(key(MARKER), latin1(value))])]),
        )
        .unwrap();
    };
    write("000010.log", 100, "1000");
    write("000012.log", 200, "2000");
    // A table, and a file that is not LevelDB's, are not read.
    write("000011.ldb", 300, "3000");
    write("notes.log", 400, "4000");
    assert_eq!(last_draft_wipe_at(&leveldb), Some(2000.0));
    // No folder at all.
    assert_eq!(last_draft_wipe_at(&scratch.path().join("absent")), None);
}
