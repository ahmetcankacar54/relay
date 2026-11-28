//! Port of tests/proxy-clients.test.ts (client files, lines 25–189) and the file-level half of
//! its omp cases (311–494) for `services::gateway::clients`: every case on a temp home, never
//! the real ~/.claude, ~/.codex or ~/.omp. The omp text layouts are covered in relay-gateway.

use std::fs;
use std::path::{Path, PathBuf};

use relay_app::services::gateway::clients::{
    ClientTarget, SavedValues, bind_client, client_statuses, release_client_sync, unbind_client,
};
use relay_core::shared::proxy_types::{ClientBindings, ProxyClientId};
use serde_json::{Value, json};

const CLAUDE: ProxyClientId = ProxyClientId::ClaudeCode;
const CODEX: ProxyClientId = ProxyClientId::Codex;
const OMP: ProxyClientId = ProxyClientId::Omp;

fn target() -> ClientTarget {
    ClientTarget {
        url: "http://127.0.0.1:8317".into(),
        key: "relay-sec-test-key".into(),
    }
}

fn with_key(key: &str) -> ClientTarget {
    ClientTarget {
        key: key.into(),
        ..target()
    }
}

fn home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-clients-")
        .tempdir()
        .unwrap()
}

fn claude_file(dir: &Path) -> PathBuf {
    dir.join(".claude").join("settings.json")
}

fn codex_file(dir: &Path) -> PathBuf {
    dir.join(".codex").join("config.toml")
}

fn omp_dir(dir: &Path) -> PathBuf {
    dir.join(".omp").join("agent")
}

fn omp_file(dir: &Path) -> PathBuf {
    omp_dir(dir).join("models.yml")
}

fn write(file: &Path, text: &str) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, text).unwrap();
}

fn read(file: &Path) -> String {
    fs::read_to_string(file).unwrap()
}

fn read_json(file: &Path) -> Value {
    serde_json::from_str(&read(file)).unwrap()
}

/// `{ name: value | null, ... }`.
fn saved(pairs: &[(&str, Option<&str>)]) -> SavedValues {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.map(str::to_owned)))
        .collect()
}

fn saved_json(values: &SavedValues) -> Value {
    serde_json::to_value(values).unwrap()
}

fn bindings(id: ProxyClientId, values: SavedValues) -> ClientBindings {
    let mut out = ClientBindings::new();
    out.insert(id, values);
    out
}

fn status(
    target: &ClientTarget,
    bound: Option<&ClientBindings>,
    dir: &Path,
    index: usize,
) -> Value {
    client_statuses(Some(target), bound, dir)[index].clone()
}

fn pair(status: &Value) -> (Value, Value) {
    (status["bound"].clone(), status["stale"].clone())
}

#[cfg(unix)]
fn mode(file: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(file).unwrap().permissions().mode() & 0o777
}

#[cfg(unix)]
fn chmod(file: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(file, fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(unix)]
#[test]
fn a_client_file_holding_the_gateway_key_is_owner_only_also_over_a_file_that_was_readable_by_all() {
    let dir = home();
    let dir = dir.path();
    let files = [
        (CLAUDE, claude_file(dir)),
        (CODEX, codex_file(dir)),
        (OMP, omp_file(dir)),
    ];
    for (id, file) in &files {
        write(file, if *id == CLAUDE { "{}" } else { "" });
        chmod(file, 0o644);
        bind_client(*id, &target(), None, dir).unwrap();
        assert!(read(file).contains("relay-sec-test-key"), "{id:?}");
        assert_eq!(mode(file), 0o600, "{id:?}");
    }
    // Putting the files back while quitting keeps them owner-only too.
    chmod(&files[1].1, 0o644);
    release_client_sync(CODEX, None, dir);
    assert_eq!(mode(&files[1].1), 0o600);
}

#[test]
fn binding_claude_code_writes_the_gateway_into_settings_json_and_unbinding_restores_the_old_values()
{
    let dir = home();
    let dir = dir.path();
    let file = claude_file(dir);
    write(
        &file,
        &json!({ "model": "opus", "env": { "ANTHROPIC_BASE_URL": "https://old.example", "OTHER": "1" } })
            .to_string(),
    );
    let kept = bind_client(CLAUDE, &target(), None, dir).unwrap();
    assert_eq!(
        saved_json(&kept),
        json!({
            "ANTHROPIC_BASE_URL": "https://old.example",
            "ANTHROPIC_AUTH_TOKEN": null,
            "CLAUDE_CODE_PROMPT_CACHE_TTL": null,
            "CLAUDE_CODE_GATEWAY_HINT_HEADERS": null,
        })
    );
    let bound = read_json(&file);
    assert_eq!(bound["model"], "opus");
    assert_eq!(
        bound["env"],
        json!({
            "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
            "OTHER": "1",
            "ANTHROPIC_AUTH_TOKEN": "relay-sec-test-key",
            "CLAUDE_CODE_PROMPT_CACHE_TTL": "1h",
            "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
        })
    );
    let b = bindings(CLAUDE, kept.clone());
    let claude = status(&target(), Some(&b), dir, 0);
    assert_eq!(claude["installed"], true);
    assert_eq!(pair(&claude), (json!(true), json!(false)));
    // A new key: still Relay's binding, but out of date until it is written again.
    let stale = status(&with_key("relay-sec-new"), Some(&b), dir, 0);
    assert_eq!(pair(&stale), (json!(false), json!(true)));
    // A rebind keeps the first saved values.
    assert_eq!(
        bind_client(CLAUDE, &with_key("relay-sec-new"), Some(&kept), dir).unwrap(),
        kept
    );
    unbind_client(CLAUDE, Some(&kept), dir).unwrap();
    assert_eq!(
        read_json(&file),
        json!({ "model": "opus", "env": { "ANTHROPIC_BASE_URL": "https://old.example", "OTHER": "1" } })
    );
}

#[test]
fn unbinding_claude_code_drops_an_env_block_relay_emptied() {
    let dir = home();
    let dir = dir.path();
    let kept = bind_client(CLAUDE, &target(), None, dir).unwrap();
    unbind_client(CLAUDE, Some(&kept), dir).unwrap();
    assert_eq!(read_json(&claude_file(dir)), json!({}));
}

#[test]
fn the_cache_lifetime_and_hint_headers_are_added_only_where_the_user_set_none_and_only_relays_go_on_unbind()
 {
    let dir = home();
    let dir = dir.path();
    let file = claude_file(dir);
    write(
        &file,
        &json!({ "env": { "CLAUDE_CODE_PROMPT_CACHE_TTL": "5m" } }).to_string(),
    );
    let kept = bind_client(CLAUDE, &target(), None, dir).unwrap();
    assert!(
        !kept.contains_key("CLAUDE_CODE_PROMPT_CACHE_TTL"),
        "the user's own lifetime is not Relay's to restore"
    );
    let mut env = read_json(&file)["env"].clone();
    assert_eq!(env["CLAUDE_CODE_PROMPT_CACHE_TTL"], "5m");
    assert_eq!(env["CLAUDE_CODE_GATEWAY_HINT_HEADERS"], "1");
    // Changed by the user while bound: a rebind and the unbind both leave it.
    env["CLAUDE_CODE_GATEWAY_HINT_HEADERS"] = json!("0");
    write(&file, &json!({ "env": env }).to_string());
    bind_client(CLAUDE, &target(), Some(&kept), dir).unwrap();
    assert_eq!(
        read_json(&file)["env"]["CLAUDE_CODE_GATEWAY_HINT_HEADERS"],
        "0"
    );
    unbind_client(CLAUDE, Some(&kept), dir).unwrap();
    assert_eq!(
        read_json(&file)["env"],
        json!({ "CLAUDE_CODE_PROMPT_CACHE_TTL": "5m", "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "0" })
    );
}

#[test]
fn a_binding_from_before_the_extras_reads_as_out_of_date_and_writing_it_again_adds_them() {
    let dir = home();
    let dir = dir.path();
    write(
        &claude_file(dir),
        &json!({ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317", "ANTHROPIC_AUTH_TOKEN": "relay-sec-test-key" } })
            .to_string(),
    );
    let old = saved(&[("ANTHROPIC_BASE_URL", None), ("ANTHROPIC_AUTH_TOKEN", None)]);
    let before = status(&target(), Some(&bindings(CLAUDE, old.clone())), dir, 0);
    assert_eq!(pair(&before), (json!(false), json!(true)));
    let kept = bind_client(CLAUDE, &target(), Some(&old), dir).unwrap();
    assert_eq!(
        saved_json(&kept),
        json!({
            "ANTHROPIC_BASE_URL": null,
            "ANTHROPIC_AUTH_TOKEN": null,
            "CLAUDE_CODE_PROMPT_CACHE_TTL": null,
            "CLAUDE_CODE_GATEWAY_HINT_HEADERS": null,
        })
    );
    assert_eq!(
        status(&target(), Some(&bindings(CLAUDE, kept)), dir, 0)["bound"],
        true
    );
}

#[test]
fn a_file_relay_left_bound_is_not_taken_for_the_users_values_and_a_binding_with_nothing_to_change_is_not_rewritten()
 {
    let dir = home();
    let dir = dir.path();
    let file = claude_file(dir);
    // Relay crashed while bound: the file holds the gateway and an older Relay key.
    write(
        &file,
        &json!({ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317", "ANTHROPIC_AUTH_TOKEN": "relay-sec-older" } })
            .to_string(),
    );
    let kept = bind_client(CLAUDE, &target(), None, dir).unwrap();
    assert_eq!(kept.get("ANTHROPIC_BASE_URL"), Some(&None));
    assert_eq!(kept.get("ANTHROPIC_AUTH_TOKEN"), Some(&None));
    let modified = fs::metadata(&file).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    bind_client(CLAUDE, &target(), Some(&kept), dir).unwrap();
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), modified);
}

#[test]
fn quitting_puts_both_clients_files_back_synchronously_and_keeps_nothing_of_relays_in_them() {
    let dir = home();
    let dir = dir.path();
    let claude = claude_file(dir);
    write(
        &claude,
        &json!({ "env": { "ANTHROPIC_BASE_URL": "https://mine.example" } }).to_string(),
    );
    let codex = codex_file(dir);
    write(&codex, "model_provider = \"openai\"\n");
    let kept_claude = bind_client(CLAUDE, &target(), None, dir).unwrap();
    let kept_codex = bind_client(CODEX, &target(), None, dir).unwrap();
    release_client_sync(CLAUDE, Some(&kept_claude), dir);
    release_client_sync(CODEX, Some(&kept_codex), dir);
    assert_eq!(
        read_json(&claude),
        json!({ "env": { "ANTHROPIC_BASE_URL": "https://mine.example" } })
    );
    assert_eq!(read(&codex), "model_provider = \"openai\"\n");
    // The next start binds again from the saved values.
    bind_client(CLAUDE, &target(), Some(&kept_claude), dir).unwrap();
    assert_eq!(
        read_json(&claude)["env"]["ANTHROPIC_BASE_URL"],
        "http://127.0.0.1:8317"
    );
}

#[test]
fn an_unreadable_settings_json_is_reported_never_overwritten() {
    let dir = home();
    let dir = dir.path();
    let file = claude_file(dir);
    write(&file, "{ not json");
    assert_eq!(
        client_statuses(Some(&target()), None, dir)[0]["blocked"],
        "unreadable-settings"
    );
    assert!(bind_client(CLAUDE, &target(), None, dir).is_err());
    assert_eq!(read(&file), "{ not json");
}

#[test]
fn binding_codex_adds_relays_provider_parks_an_existing_one_and_unbinding_puts_the_file_back() {
    let dir = home();
    let dir = dir.path();
    let file = codex_file(dir);
    let original = "model = \"gpt-5\"\nmodel_provider = \"openai\"\n\n[profiles.fast]\nmodel = \"gpt-5-mini\"\n";
    write(&file, original);
    bind_client(CODEX, &target(), None, dir).unwrap();
    let text = read(&file);
    // The top-level key comes before any table, as TOML requires.
    assert!(
        text.find("model_provider = \"relay\"").unwrap() < text.find("[profiles.fast]").unwrap()
    );
    assert!(text.contains("# relay-disabled: model_provider = \"openai\""));
    let table = &text[text
        .find("[model_providers.relay]")
        .expect("relay's provider")..];
    let url = table
        .find("base_url = \"http://127.0.0.1:8317/v1\"")
        .expect("base_url");
    let token = table
        .find("experimental_bearer_token = \"relay-sec-test-key\"")
        .expect("token");
    assert!(url < token);
    let codex = status(
        &target(),
        Some(&bindings(CODEX, SavedValues::new())),
        dir,
        1,
    );
    assert_eq!(pair(&codex), (json!(true), json!(false)));
    // Binding twice leaves one copy of each block.
    bind_client(CODEX, &target(), Some(&SavedValues::new()), dir).unwrap();
    assert_eq!(read(&file).matches("[model_providers.relay]").count(), 1);
    unbind_client(CODEX, Some(&SavedValues::new()), dir).unwrap();
    assert_eq!(read(&file), original);
}

#[test]
fn a_tool_whose_folder_is_missing_reads_as_not_installed_and_not_bound() {
    let dir = home();
    let statuses = client_statuses(Some(&target()), None, dir.path());
    let flags: Vec<Value> = [&statuses[0], &statuses[1]]
        .iter()
        .flat_map(|s| [s["installed"].clone(), s["bound"].clone()])
        .collect();
    assert_eq!(flags, vec![json!(false); 4]);
}

// omp, the file side.

fn omp_status(dir: &Path, bound: bool, to: &ClientTarget) -> Value {
    let b = bound.then(|| bindings(OMP, SavedValues::new()));
    status(to, b.as_ref(), dir, 2)
}

#[test]
fn omp_one_click_writes_models_yml_the_next_takes_it_away_leaving_no_file_relay_made() {
    let dir = home();
    let dir = dir.path();
    fs::create_dir_all(omp_dir(dir)).unwrap();
    assert_eq!(omp_status(dir, false, &target())["bound"], false);
    let kept = bind_client(OMP, &target(), None, dir).unwrap();
    assert_eq!(saved_json(&kept), json!({ "created": "1" }));
    let text = read(&omp_file(dir));
    assert!(text.contains("x-relay-key: \"relay-sec-test-key\""));
    #[cfg(unix)]
    assert_eq!(mode(&omp_file(dir)), 0o600);
    let now = omp_status(dir, true, &target());
    assert_eq!(
        (
            now["installed"].clone(),
            now["bound"].clone(),
            now["stale"].clone()
        ),
        (json!(true), json!(true), json!(false))
    );
    let moved = omp_status(dir, true, &with_key("relay-sec-other"));
    assert_eq!(pair(&moved), (json!(false), json!(true)));
    assert_eq!(bind_client(OMP, &target(), Some(&kept), dir).unwrap(), kept);
    assert_eq!(read(&omp_file(dir)), text);
    unbind_client(OMP, Some(&kept), dir).unwrap();
    assert!(!omp_file(dir).exists());
    // Quitting Relay takes it away the same way; the next start writes it again.
    bind_client(OMP, &target(), Some(&kept), dir).unwrap();
    release_client_sync(OMP, Some(&kept), dir);
    assert!(!omp_file(dir).exists());
    // Disconnecting a binding Relay has no record of still removes a file that is only Relay's.
    bind_client(OMP, &target(), None, dir).unwrap();
    unbind_client(OMP, None, dir).unwrap();
    assert!(!omp_file(dir).exists());
}

#[test]
fn omp_the_users_own_file_comes_back_byte_for_byte_on_unbind_and_quit() {
    let dir = home();
    let dir = dir.path();
    let before = "# my models\nretry: 3\n";
    write(&omp_file(dir), before);
    let kept = bind_client(OMP, &target(), None, dir).unwrap();
    assert_eq!(saved_json(&kept), json!({ "created": null }));
    assert_eq!(omp_status(dir, true, &target())["bound"], true);
    unbind_client(OMP, Some(&kept), dir).unwrap();
    assert_eq!(read(&omp_file(dir)), before);
    bind_client(OMP, &target(), Some(&kept), dir).unwrap();
    release_client_sync(OMP, Some(&kept), dir);
    assert_eq!(read(&omp_file(dir)), before);
}

#[test]
fn omp_an_empty_file_of_the_users_stays_empty_after_disconnect() {
    let dir = home();
    let dir = dir.path();
    write(&omp_file(dir), "");
    let kept = bind_client(OMP, &target(), None, dir).unwrap();
    assert_eq!(saved_json(&kept), json!({ "created": null }));
    unbind_client(OMP, Some(&kept), dir).unwrap();
    assert_eq!(read(&omp_file(dir)), "");
}

#[cfg(unix)]
#[test]
fn omp_a_symlinked_models_yml_stays_a_link_and_the_file_it_points_to_is_written() {
    let dir = home();
    let dir = dir.path();
    let real = dir.join("dotfiles").join("models.yml");
    write(&real, "retry: 3\n");
    fs::create_dir_all(omp_dir(dir)).unwrap();
    std::os::unix::fs::symlink(&real, omp_file(dir)).unwrap();
    let kept = bind_client(OMP, &target(), None, dir).unwrap();
    assert!(
        fs::symlink_metadata(omp_file(dir))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(read(&real).contains("# >>> relay gateway"));
    assert_eq!(omp_status(dir, true, &target())["bound"], true);
    unbind_client(OMP, Some(&kept), dir).unwrap();
    assert!(
        fs::symlink_metadata(omp_file(dir))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(read(&real), "retry: 3\n");
}

#[test]
fn omp_a_file_of_the_users_that_relay_found_gone_and_wrote_again_on_a_start_is_removed_on_disconnect()
 {
    let dir = home();
    let dir = dir.path();
    write(&omp_file(dir), "retry: 3\n");
    let first = bind_client(OMP, &target(), None, dir).unwrap();
    assert_eq!(saved_json(&first), json!({ "created": null }));
    fs::remove_file(omp_file(dir)).unwrap();
    let again = bind_client(OMP, &target(), Some(&first), dir).unwrap();
    assert_eq!(saved_json(&again), json!({ "created": "1" }));
    unbind_client(OMP, Some(&again), dir).unwrap();
    assert!(!omp_file(dir).exists());
}
