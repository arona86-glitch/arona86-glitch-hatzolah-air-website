/*
 * Central website link configuration — the CRM lives at app.hatzolahair.org.il.
 */
window.HATZOLAH_SITE = {
/*
 * Central website link configuration — the CRM lives at app.hatzolahair.org.il.
 */
window.HATZOLAH_SITE = {
  crmUrl: "https://app.hatzolahair.org.il",
  flightRequestUrl: "https://app.hatzolahair.org.il/request",
  flightDayUrl: "https://app.hatzolahair.org.il/flight-day"
};
};

document.addEventListener("DOMContentLoaded", () => {
  const cfg = window.HATZOLAH_SITE;
  document.querySelectorAll('[data-link="crm"]').forEach(a => a.href = cfg.crmUrl);
  document.querySelectorAll('[data-link="flight-request"]').forEach(a => a.href = cfg.flightRequestUrl);
  document.querySelectorAll('[data-link="flight-day"]').forEach(a => a.href = cfg.flightDayUrl);

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
