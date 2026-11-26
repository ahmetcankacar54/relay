//! Port of tests/cli-process-io.test.ts, the backend (`runDetached`) cases. Skipped: "a terminal
//! that hangs up mid-operation cannot crash the CLI through a failed write" (the CLI's
//! `processIO`, relay-cli's).

#[cfg(target_os = "macos")]
mod mac {
    use std::collections::BTreeMap;
    use std::process::Command;

    use relay_core::detached_exec::{ExecOptions, run_detached};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn desktop_commands_run_in_their_own_process_group_out_of_reach_of_the_terminals_ctrl_c_and_hang_up()
     {
        let own = Command::new("/bin/ps")
            .args(["-o", "pgid=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        let own = String::from_utf8(own.stdout).unwrap().trim().to_string();
        let out = run_detached(
            "/bin/sh",
            &args(&["-c", "ps -o pgid= -p $$"]),
            &ExecOptions::timeout_ms(5000),
        )
        .unwrap();
        assert_ne!(out.stdout.trim(), own);
        let error = run_detached(
            "/bin/sh",
            &args(&["-c", "echo nope >&2; exit 3"]),
            &ExecOptions::timeout_ms(5000),
        )
        .unwrap_err();
        assert_eq!(error.code, Some(3));
        assert!(error.message.contains("Command failed: /bin/sh"));
        assert!(error.message.contains("nope"));
        let error = run_detached(
            "/bin/sh",
            &args(&["-c", "sleep 5"]),
            &ExecOptions::timeout_ms(100),
        )
        .unwrap_err();
        assert!(error.killed);
    }

    #[test]
    fn a_character_split_across_two_output_chunks_comes_back_whole() {
        let out = run_detached(
            "/bin/sh",
            &args(&["-c", "printf '\\305'; sleep 0.1; printf '\\237'"]),
            &ExecOptions::timeout_ms(5000),
        )
        .unwrap();
        assert_eq!(out.stdout, "ş");
    }

    #[test]
    fn a_command_given_an_environment_gets_only_that_one_and_relays_own_otherwise() {
        // SAFETY: the only test in this binary that touches the environment.
        unsafe { std::env::set_var("RELAY_LEAK_PROBE", "from-relay") };
        let inherited = run_detached("/usr/bin/env", &[], &ExecOptions::timeout_ms(5000)).unwrap();
        assert!(
            inherited
                .stdout
                .lines()
                .any(|l| l == "RELAY_LEAK_PROBE=from-relay")
        );
        let clean = run_detached(
            "/usr/bin/env",
            &[],
            &ExecOptions {
                env: Some(BTreeMap::new()),
                ..ExecOptions::timeout_ms(5000)
            },
        )
        .unwrap();
        assert!(!clean.stdout.contains("RELAY_LEAK_PROBE"));
        let given = run_detached(
            "/usr/bin/env",
            &[],
            &ExecOptions {
                env: Some([("ONLY".to_string(), "this".to_string())].into()),
                ..ExecOptions::timeout_ms(5000)
            },
        )
        .unwrap();
        assert!(given.stdout.lines().any(|l| l == "ONLY=this"));
        assert!(!given.stdout.contains("RELAY_LEAK_PROBE"));
        unsafe { std::env::remove_var("RELAY_LEAK_PROBE") };
    }
}
