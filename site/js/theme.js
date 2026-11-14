// Theme switcher. Classic script: loaded in <head> so the theme is set before first paint.
(function () {
  var KEY = "chess-coach-theme";
  var THEMES = [
    ["pastel", "Pastel desktop"],
    ["win95", "Chess Coach 95"],
    ["dos", "CHESS.EXE"],
    ["plain", "Plain"],
  ];
  function valid(name) {
    return THEMES.some(function (t) { return t[0] === name; });
  }
  var current = "pastel";
  try {
    var saved = localStorage.getItem(KEY);
    if (valid(saved)) current = saved;
  } catch (e) { /* storage unavailable: use default */ }
  document.documentElement.dataset.theme = current;

  document.addEventListener("DOMContentLoaded", function () {
    var header = document.querySelector("header");
    if (!header) return;
    var label = document.createElement("label");
    label.className = "theme-picker";
    var text = document.createElement("span");
    text.textContent = "Theme";
    var select = document.createElement("select");
    THEMES.forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t[0];
      opt.textContent = t[1];
      select.appendChild(opt);
    });
    select.value = document.documentElement.dataset.theme;
    select.addEventListener("change", function () {
      var name = valid(select.value) ? select.value : "pastel";
      document.documentElement.dataset.theme = name;
      try { localStorage.setItem(KEY, name); } catch (e) { /* ignore */ }
      window.dispatchEvent(new Event("themechange"));
    });
    label.appendChild(text);
    label.appendChild(document.createTextNode(" "));
    label.appendChild(select);
    header.appendChild(label);
  });
})();
