//! Port of `electron/core/tray-face.ts`: sets the tray's title, tooltip and image only when they
//! change. The tray refreshes every few seconds, and each call redraws the menu bar item. A value
//! the tray refused (the call failed) is set again next time.

/// How the title's digits are drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontType {
    /// Digits of one width (`"monospacedDigit"`).
    MonospacedDigit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TitleOptions {
    pub font_type: Option<FontType>,
}

/// The part of the tray that shows the menu bar item.
pub trait TrayFaceTarget {
    type Image;
    type Error;
    fn set_title(&mut self, title: &str, options: TitleOptions) -> Result<(), Self::Error>;
    fn set_tool_tip(&mut self, tooltip: &str) -> Result<(), Self::Error>;
    fn set_image(&mut self, image: Self::Image) -> Result<(), Self::Error>;
}

pub struct TrayFace<T: TrayFaceTarget> {
    tray: T,
    title: Option<String>,
    tooltip: Option<String>,
    image: Option<String>,
}

impl<T: TrayFaceTarget> TrayFace<T> {
    pub fn new(tray: T) -> Self {
        TrayFace {
            tray,
            title: None,
            tooltip: None,
            image: None,
        }
    }

    pub fn tray(&self) -> &T {
        &self.tray
    }

    pub fn tray_mut(&mut self) -> &mut T {
        &mut self.tray
    }

    pub fn set_title(&mut self, title: &str) -> Result<(), T::Error> {
        if self.title.as_deref() == Some(title) {
            return Ok(());
        }
        // Digits of one width: a countdown or a percent that changes never shifts the menu bar
        // items beside it.
        let options = TitleOptions {
            font_type: Some(FontType::MonospacedDigit),
        };
        self.tray.set_title(title, options)?;
        self.title = Some(title.to_string());
        Ok(())
    }

    pub fn set_tool_tip(&mut self, tooltip: &str) -> Result<(), T::Error> {
        if self.tooltip.as_deref() == Some(tooltip) {
            return Ok(());
        }
        self.tray.set_tool_tip(tooltip)?;
        self.tooltip = Some(tooltip.to_string());
        Ok(())
    }

    /// `key` names the image; `image` is only called when the key changed.
    pub fn set_image(
        &mut self,
        key: &str,
        image: impl FnOnce() -> T::Image,
    ) -> Result<(), T::Error> {
        if self.image.as_deref() == Some(key) {
            return Ok(());
        }
        self.tray.set_image(image())?;
        self.image = Some(key.to_string());
        Ok(())
    }
}
