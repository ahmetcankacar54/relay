//! Port of tests/tray-place.test.ts.

use std::collections::HashMap;

use relay_core::tray_place::{TRAY_GUID, TRAY_START_POSITION, TrayDefaults, place_tray};

#[derive(Default)]
struct Defaults {
    saved: HashMap<String, f64>,
    writes: Vec<(String, f64)>,
}

impl TrayDefaults for Defaults {
    type Error = std::convert::Infallible;
    // As NSUserDefaults: a float never set reads 0.
    fn get_user_default(&mut self, key: &str) -> Result<f64, Self::Error> {
        Ok(self.saved.get(key).copied().unwrap_or(0.0))
    }
    fn set_user_default(&mut self, key: &str, value: f64) -> Result<(), Self::Error> {
        self.saved.insert(key.to_string(), value);
        self.writes.push((key.to_string(), value));
        Ok(())
    }
}

struct Broken;

impl TrayDefaults for Broken {
    type Error = &'static str;
    fn get_user_default(&mut self, _key: &str) -> Result<f64, Self::Error> {
        Err("no defaults")
    }
    fn set_user_default(&mut self, _key: &str, _value: f64) -> Result<(), Self::Error> {
        Err("no defaults")
    }
}

fn key() -> String {
    format!("NSStatusItem Preferred Position {TRAY_GUID}")
}

#[test]
fn an_item_never_placed_starts_right_of_the_notch_under_its_own_id() {
    let mut d = Defaults::default();
    place_tray(&mut d, TRAY_GUID);
    assert_eq!(d.writes, [(key(), TRAY_START_POSITION)]);
}

#[test]
fn a_place_kept_from_an_earlier_start_or_the_user_s_drag_is_left_as_it_is() {
    let mut d = Defaults::default();
    d.saved.insert(key(), 812.5);
    place_tray(&mut d, TRAY_GUID);
    assert!(d.writes.is_empty());
}

#[test]
fn defaults_that_cannot_be_read_leave_the_item_where_appkit_puts_it() {
    place_tray(&mut Broken, TRAY_GUID);
}
