// Relay site: latest release links, the demo film, copy buttons. No dependencies.
(() => {
  "use strict";

  const API = "https://api.github.com/repos/ahmetcankacar54/relay/releases/latest";
  const CACHE_KEY = "relay:latest-release";
  const CACHE_MS = 60 * 60 * 1000;
  const ASSETS = {
    mac: /^Relay-[\d.]+-arm64\.dmg$/i,
    win: /^Relay-Setup-[\d.]+-x64\.exe$/i,
    linux: /^Relay-[\d.]+-x86_64\.AppImage$/i,
  };

  // Release: version tag and direct download links. The static HTML already links to
  // releases/latest, so any failure here leaves working links behind.
  function readCache() {
    try {
      const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      return hit && Date.now() - hit.at < CACHE_MS ? hit.release : null;
    } catch {
      return null;
    }
  }

  function writeCache(release) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
    } catch {
      /* storage can be unavailable; the next visit fetches again */
    }
  }

  async function latestRelease() {
    const cached = readCache();
    if (cached) return cached;
    const response = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    const data = await response.json();
    const release = {
      tag: String(data.tag_name || ""),
      url: String(data.html_url || ""),
      assets: (data.assets || []).map((a) => ({ name: String(a.name), url: String(a.browser_download_url) })),
    };
    writeCache(release);
    return release;
  }

  function applyRelease(release) {
    if (/^v?\d+\.\d+\.\d+/.test(release.tag)) {
      const tag = release.tag.startsWith("v") ? release.tag : `v${release.tag}`;
      document.querySelectorAll("[data-version]").forEach((el) => { el.textContent = tag; });
    }
    if (release.url.startsWith("https://github.com/")) {
      document.querySelectorAll("[data-release-link]").forEach((el) => { el.href = release.url; });
    }
    document.querySelectorAll("[data-download]").forEach((link) => {
      const pattern = ASSETS[link.dataset.download];
      const asset = pattern && release.assets.find((a) => pattern.test(a.name));
      if (!asset || !asset.url.startsWith("https://github.com/")) return;
      link.href = asset.url;
      if (link.hasAttribute("data-filename")) link.textContent = asset.name;
    });
  }

  latestRelease().then(applyRelease).catch(() => { /* keep the static fallback */ });

  // Film: plays muted while on screen, never on its own under reduced motion.
  const video = document.querySelector(".film__video");
  if (video) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let userPaused = false;

    const sync = () => {
      if (!visible) {
        if (!video.paused) video.pause();
        return;
      }
      // Under reduced motion only the viewer starts the film.
      if (reduce.matches || userPaused || !video.paused) return;
      video.play().catch(() => { /* autoplay refused; the controls remain */ });
    };

    video.addEventListener("pause", () => {
      // A pause while visible and allowed to play came from the viewer.
      if (visible && !reduce.matches && !document.hidden) userPaused = true;
    });
    video.addEventListener("play", () => { userPaused = false; });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.2 }).observe(video);
    } else {
      visible = true;
      sync();
    }
    reduce.addEventListener("change", sync);
  }

  // Copy buttons for commands.
  const status = document.createElement("p");
  status.className = "visually-hidden";
  status.setAttribute("aria-live", "polite");
  document.body.append(status);

  document.querySelectorAll("button[data-copy]").forEach((button) => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    const label = button.firstChild;
    const idle = label.textContent;
    let timer = 0;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        label.textContent = "Copied";
        button.dataset.state = "done";
        status.textContent = "Copied to the clipboard.";
      } catch {
        // No clipboard access: select the command so the viewer can copy it by hand.
        window.getSelection().selectAllChildren(source);
        label.textContent = "Selected";
        status.textContent = "Selected. Copy it with Command-C or Control-C.";
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        label.textContent = idle;
        delete button.dataset.state;
      }, 1800);
    });
  });
})();
