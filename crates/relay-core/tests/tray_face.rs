//! Port of tests/tray-face.test.ts. Skipped, source-text: "the menu bar tray sets its title,
//! tooltip and panda through the face" (reads electron/tray.ts).

use relay_core::tray_face::{FontType, TitleOptions, TrayFace, TrayFaceTarget};

#[derive(Default)]
struct FakeTray {
    calls: Vec<String>,
    fonts: Vec<Option<FontType>>,
    refuse: bool,
}

impl FakeTray {
    fn check(&self) -> Result<(), &'static str> {
        if self.refuse { Err("refused") } else { Ok(()) }
    }
}

impl TrayFaceTarget for FakeTray {
    type Image = String;
    type Error = &'static str;
    fn set_title(&mut self, title: &str, options: TitleOptions) -> Result<(), Self::Error> {
        self.check()?;
        self.calls.push(format!("title:{title}"));
        self.fonts.push(options.font_type);
        Ok(())
    }
    fn set_tool_tip(&mut self, tooltip: &str) -> Result<(), Self::Error> {
        self.check()?;
        self.calls.push(format!("tooltip:{tooltip}"));
        Ok(())
    }
    fn set_image(&mut self, image: String) -> Result<(), Self::Error> {
        self.check()?;
        self.calls.push(format!("image:{image}"));
        Ok(())
    }
}

#[test]
fn the_tray_s_title_tooltip_and_image_are_set_only_when_they_change() {
    let mut face = TrayFace::new(FakeTray::default());
    let built = std::cell::Cell::new(0);
    let image = |name: &str| {
        built.set(built.get() + 1);
        format!("{name}.png")
    };
    face.set_title(" 40%").unwrap();
    face.set_tool_tip("Relay · A").unwrap();
    face.set_image("idle", || image("idle")).unwrap();
    face.set_title(" 40%").unwrap();
    face.set_tool_tip("Relay · A").unwrap();
    face.set_image("idle", || image("idle")).unwrap();
    assert_eq!(
        face.tray().calls,
        ["title: 40%", "tooltip:Relay · A", "image:idle.png"]
    );
    assert_eq!(built.get(), 1);
    face.set_title(" 41%").unwrap();
    face.set_image("blink", || image("blink")).unwrap();
    face.set_tool_tip("Relay · A").unwrap();
    assert_eq!(face.tray().calls[3..], ["title: 41%", "image:blink.png"]);
    // Digits of one width, so a changing figure never moves the menu bar items beside it.
    assert_eq!(
        face.tray().fonts,
        [
            Some(FontType::MonospacedDigit),
            Some(FontType::MonospacedDigit)
        ]
    );
}

#[test]
fn a_value_the_tray_refused_is_set_again_next_time() {
    let mut face = TrayFace::new(FakeTray::default());
    face.tray_mut().refuse = true;
    assert!(face.set_title(" 40%").is_err());
    assert!(face.set_image("idle", || "idle.png".to_string()).is_err());
    face.tray_mut().refuse = false;
    face.set_title(" 40%").unwrap();
    face.set_image("idle", || "idle.png".to_string()).unwrap();
    assert_eq!(face.tray().calls, ["title: 40%", "image:idle.png"]);
}
