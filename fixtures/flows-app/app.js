const nav = document.getElementById("mainNav");

document.getElementById("menuToggle").addEventListener("click", () => {
  nav.classList.toggle("open");
});

function show(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
  nav.classList.remove("open");
}

document.querySelectorAll(".nav-link").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    show(a.getAttribute("href").slice(1));
  })
);

document.getElementById("btnTrial").addEventListener("click", () => {
  document.getElementById("trialModal").hidden = false;
});

document.getElementById("btnCloseTrial").addEventListener("click", () => {
  document.getElementById("trialModal").hidden = true;
});

document.getElementById("btnReviews").addEventListener("click", () => {
  // Seeded runtime defect: reviews widget assumes an element that does not exist
  const widget = document.querySelector("#reviewsWidget");
  widget.dataset.loaded = "true";
});

document.getElementById("contactForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("contactEmail").value;
  document.getElementById("contactError").hidden = /.+@.+\..+/.test(email);
  // Seeded runtime defect: analytics SDK is not loaded on this page
  window.analytics.track("contact_submit");
});
