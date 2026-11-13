(() => {
  "use strict";
  const ids = ["enabled", "format", "includeTranslation", "includeRomanization", "saveAs"];
  const controls = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const status = document.getElementById("save-status");

  function apply(preferences) {
    for (const id of ids) {
      if (id === "format") controls[id].value = preferences[id];
      else controls[id].checked = preferences[id];
    }
  }

  async function save() {
    const preferences = HELyrics.normalizePreferences(Object.fromEntries(ids.map((id) =>
      [id, id === "format" ? controls[id].value : controls[id].checked])));
    try {
      await chrome.storage.local.set({ preferences });
      status.textContent = "已保存，新打开和当前的下载窗口都会生效";
      status.classList.remove("error");
    } catch {
      status.textContent = "保存失败，请关闭此窗口后重试";
      status.classList.add("error");
    }
  }

  async function initialize() {
    for (const control of Object.values(controls)) control.disabled = true;
    try {
      const saved = await chrome.storage.local.get("preferences");
      apply(HELyrics.normalizePreferences(saved.preferences));
    } catch {
      apply(HELyrics.normalizePreferences());
      status.textContent = "无法读取设置，当前显示默认值";
      status.classList.add("error");
    }
    for (const control of Object.values(controls)) {
      control.disabled = false;
      control.addEventListener("change", save);
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.preferences) apply(HELyrics.normalizePreferences(changes.preferences.newValue));
  });
  void initialize();
})();
