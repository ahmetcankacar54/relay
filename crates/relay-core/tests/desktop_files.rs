//! The desktop-files primitives. No TS test covers `electron/core/desktop-files.ts` by itself
//! (every `tests/*.test.ts` import of it uses `writeBytes`/`readBytes`/`readObject`/`jsonBytes`
//! as fixtures); these cases pin the contract those fixtures and the vault rely on.

use std::fs;

use relay_core::desktop_files::{
    DesktopFileError, Scope, directories, identity, is_uuid, json_bytes, read_bytes, read_object,
    safe_file, scope_path, write_bytes,
};
use serde_json::json;

const A: &str = "0b7b2d6e-3c1f-4f8e-9a51-2a8d1c4b5e6f";
const B: &str = "1c8c3e7f-4d20-4a9f-8b62-3b9e2d5c6f70";

fn root() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-desktop-files-")
        .tempdir()
        .unwrap()
}

#[test]
fn write_bytes_replaces_through_a_private_temporary_and_creates_private_folders() {
    let dir = root();
    write_bytes(dir.path(), "a/b/config.json", Some(b"one")).unwrap();
    write_bytes(dir.path(), "a/b/config.json", Some(b"two")).unwrap();
    assert_eq!(
        read_bytes(dir.path(), "a/b/config.json")
            .unwrap()
            .as_deref(),
        Some(&b"two"[..])
    );
    let names: Vec<String> = fs::read_dir(dir.path().join("a/b"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, ["config.json"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &str| {
            fs::metadata(dir.path().join(p))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode("a/b/config.json"), 0o600);
        assert_eq!(mode("a"), 0o700);
        assert_eq!(mode("a/b"), 0o700);
    }
    write_bytes(dir.path(), "a/b/config.json", None).unwrap();
    assert_eq!(read_bytes(dir.path(), "a/b/config.json").unwrap(), None);
    // Removing what is not there is fine.
    write_bytes(dir.path(), "a/b/config.json", None).unwrap();
}

#[test]
fn paths_outside_the_root_are_refused() {
    let dir = root();
    for relative in ["../x", "a/../../x", "", "."] {
        assert!(
            matches!(
                safe_file(dir.path(), relative),
                Err(DesktopFileError::InvalidPath)
            ),
            "{relative}"
        );
    }
    let outside = dir.path().parent().unwrap().join("x");
    assert!(matches!(
        write_bytes(dir.path(), outside.to_str().unwrap(), Some(b"x")),
        Err(DesktopFileError::InvalidPath)
    ));
    assert_eq!(
        safe_file(dir.path(), "a/./b/../c").unwrap(),
        relay_core::fs_util::resolve(&dir.path().join("a").join("c"))
    );
}

#[cfg(unix)]
#[test]
fn symbolic_links_anywhere_on_the_way_are_refused() {
    let dir = root();
    let elsewhere = root();
    std::os::unix::fs::symlink(elsewhere.path(), dir.path().join("link")).unwrap();
    assert_eq!(
        write_bytes(dir.path(), "link/file", Some(b"x"))
            .unwrap_err()
            .to_string(),
        "Desktop data cannot contain symbolic links."
    );
    assert!(fs::read_dir(elsewhere.path()).unwrap().next().is_none());
    fs::write(elsewhere.path().join("t"), "x").unwrap();
    std::os::unix::fs::symlink(elsewhere.path().join("t"), dir.path().join("f")).unwrap();
    assert!(matches!(
        read_bytes(dir.path(), "f"),
        Err(DesktopFileError::SymbolicLink)
    ));
}

#[test]
fn only_regular_files_are_read() {
    let dir = root();
    fs::create_dir(dir.path().join("folder")).unwrap();
    assert_eq!(
        read_bytes(dir.path(), "folder").unwrap_err().to_string(),
        "Unsupported Desktop file size or type."
    );
    assert_eq!(read_bytes(dir.path(), "missing/file").unwrap(), None);
}

#[test]
fn read_object_takes_objects_only() {
    let dir = root();
    write_bytes(dir.path(), "o.json", Some(br#"{"b":1,"a":2}"#)).unwrap();
    let obj = read_object(dir.path(), "o.json").unwrap().unwrap();
    assert_eq!(obj.keys().collect::<Vec<_>>(), ["b", "a"]);
    for (name, data) in [
        ("arr.json", "[]"),
        ("null.json", "null"),
        ("s.json", "\"x\""),
    ] {
        write_bytes(dir.path(), name, Some(data.as_bytes())).unwrap();
        assert_eq!(
            read_object(dir.path(), name).unwrap_err().to_string(),
            "Unsupported Desktop data format."
        );
    }
    write_bytes(dir.path(), "bad.json", Some(b"{")).unwrap();
    assert!(matches!(
        read_object(dir.path(), "bad.json"),
        Err(DesktopFileError::Json(_))
    ));
    assert_eq!(read_object(dir.path(), "none.json").unwrap(), None);
}

#[test]
fn json_bytes_matches_json_stringify_with_two_spaces() {
    // `JSON.stringify(value, null, 2)` from Node, byte for byte.
    let value = json!({"a": [], "b": {}, "c": [1, {"d": "é\u{1}\"/"}], "e": null, "f": 1.5});
    assert_eq!(
        String::from_utf8(json_bytes(&value)).unwrap(),
        "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": \"é\\u0001\\\"/\"\n    }\n  ],\n  \"e\": null,\n  \"f\": 1.5\n}"
    );
}

#[test]
fn identity_needs_a_uuid_and_a_token_cache() {
    let config = |v: serde_json::Value| v.as_object().unwrap().clone();
    assert_eq!(
        identity(Some(&config(
            json!({"lastKnownAccountUuid": A, "oauth:tokenCacheV2": "x"})
        ))),
        Some(A.to_owned())
    );
    assert_eq!(
        identity(Some(&config(
            json!({"lastKnownAccountUuid": A, "oauth:tokenCacheV2": ""})
        ))),
        None
    );
    assert_eq!(
        identity(Some(&config(
            json!({"lastKnownAccountUuid": "nope", "oauth:tokenCacheV2": "x"})
        ))),
        None
    );
    assert_eq!(identity(None), None);
}

#[test]
fn directories_lists_uuid_folders_only() {
    let dir = root();
    for name in [A, B, "not-a-uuid"] {
        fs::create_dir_all(dir.path().join("kind").join(name)).unwrap();
    }
    fs::write(
        dir.path()
            .join("kind")
            .join("2d9f4e80-5e31-4b0a-9c73-4caf3e6d7081"),
        "",
    )
    .unwrap();
    let mut found = directories(dir.path(), "kind").unwrap();
    found.sort();
    assert_eq!(found, [A, B]);
    assert!(directories(dir.path(), "missing").unwrap().is_empty());
}

#[test]
fn scope_paths_need_uuids() {
    let scope = Scope {
        account_uuid: A.into(),
        org_id: B.into(),
    };
    assert_eq!(
        scope_path("claude-code-sessions", &scope).unwrap(),
        format!("claude-code-sessions/{A}/{B}")
    );
    let bad = Scope {
        account_uuid: "../x".into(),
        org_id: B.into(),
    };
    assert!(matches!(
        scope_path("k", &bad),
        Err(DesktopFileError::InvalidUuid)
    ));
}

#[test]
fn is_uuid_follows_zod() {
    assert!(is_uuid(A));
    assert!(is_uuid(&A.to_uppercase()));
    assert!(is_uuid("00000000-0000-0000-0000-000000000000"));
    assert!(is_uuid("ffffffff-ffff-ffff-ffff-ffffffffffff"));
    // Version 0 and variant 0 are not RFC 9562 uuids.
    assert!(!is_uuid("0b7b2d6e-3c1f-0f8e-9a51-2a8d1c4b5e6f"));
    assert!(!is_uuid("0b7b2d6e-3c1f-4f8e-7a51-2a8d1c4b5e6f"));
    assert!(!is_uuid("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"));
}
