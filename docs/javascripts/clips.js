// Feature clips autoplay muted. Readers who ask for reduced motion get a
// paused clip with controls instead.
(function () {
  function apply() {
    if (!window.matchMedia || !window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelectorAll(".zlens-clip video").forEach(function (video) {
      video.removeAttribute("autoplay");
      video.pause();
      video.controls = true;
    });
  }
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(apply);
  else document.addEventListener("DOMContentLoaded", apply);
})();
