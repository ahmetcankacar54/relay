//! Port of tests/code-tab.test.ts. Skipped: "the main process opens only the fixed Code link
//! through its own channel" (reads electron/main source text); its constant check is kept below.

use std::convert::Infallible;

use relay_core::code_tab::{
    CODE_TAB_LINK, CODE_TAB_TIMEOUT_MS, CodeTabDeps, CodeTabOutcome, open_code_tab,
};

struct World {
    now: i64,
    calls: Vec<String>,
    booted: fn(i64) -> Option<bool>,
    running: bool,
}

impl CodeTabDeps for World {
    type Error = Infallible;
    fn open(&mut self) -> Result<(), Infallible> {
        self.calls.push("open".into());
        Ok(())
    }
    fn booted(&mut self) -> Result<Option<bool>, Infallible> {
        Ok((self.booted)(self.now))
    }
    fn running(&mut self) -> Result<bool, Infallible> {
        Ok(self.running)
    }
    fn open_link(&mut self, url: &str) -> Result<(), Infallible> {
        self.calls.push(url.into());
        Ok(())
    }
    fn sleep(&mut self, ms: u64) {
        self.now += ms as i64;
    }
    fn now(&self) -> i64 {
        self.now
    }
}

fn world(booted: fn(i64) -> Option<bool>) -> World {
    World {
        now: 0,
        calls: Vec::new(),
        booted,
        running: true,
    }
}

#[test]
fn the_code_link_waits_for_claudes_page_to_boot_so_it_does_not_restart_the_boot() {
    let mut w = world(|t| Some(t >= 3_000));
    assert_eq!(
        open_code_tab(&mut w, CODE_TAB_TIMEOUT_MS),
        Ok(CodeTabOutcome::Opened)
    );
    assert_eq!(w.calls, vec!["open", CODE_TAB_LINK]);
    assert!(w.now >= 3_000);
}

#[test]
fn a_claude_whose_log_cannot_tell_gets_a_short_grace_one_that_never_boots_gets_no_link() {
    let mut untold = world(|_| None);
    assert_eq!(
        open_code_tab(&mut untold, CODE_TAB_TIMEOUT_MS),
        Ok(CodeTabOutcome::Opened)
    );
    assert!(untold.now >= 4_000 && untold.now < 6_000);
    let mut stuck = world(|_| Some(false));
    assert_eq!(
        open_code_tab(&mut stuck, 10_000),
        Ok(CodeTabOutcome::Timeout)
    );
    assert_eq!(stuck.calls, vec!["open"]);
}

#[test]
fn the_code_link_is_the_fixed_new_session_screen() {
    assert_eq!(CODE_TAB_LINK, "claude://code/new");
}
