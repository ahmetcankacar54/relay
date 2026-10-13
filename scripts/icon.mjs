import sharp from "sharp";
await sharp("assets/icon.svg")
  .resize(1024, 1024)
  .png()
  .toFile("assets/icon.png");
console.log("Generated application icon from assets/icon.svg");
