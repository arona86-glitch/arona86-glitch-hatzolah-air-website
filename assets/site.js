/*
 * Central website link configuration.
 * When app.hatzolahair.org.il is ready, change only these URLs.
 */
window.HATZOLAH_SITE = {
  crmUrl: "https://app.adler-md.com",
  flightRequestUrl: "https://app.adler-md.com/request",
  futureCrmUrl: "https://app.hatzolahair.org.il",
  futureFlightRequestUrl: "https://app.hatzolahair.org.il/request"
};

document.addEventListener("DOMContentLoaded", () => {
  const cfg = window.HATZOLAH_SITE;
  document.querySelectorAll('[data-link="crm"]').forEach(a => a.href = cfg.crmUrl);
  document.querySelectorAll('[data-link="flight-request"]').forEach(a => a.href = cfg.flightRequestUrl);

  const toggle = document.querySelector(".mobile-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const isOpen = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });
  }

  document.querySelectorAll('.nav-links a').forEach(a => {
    a.addEventListener('click', () => links?.classList.remove('open'));
  });
});
