document.addEventListener("DOMContentLoaded", () => {
    const currentYear = document.querySelector("#current-year");

    if (currentYear) {
        currentYear.textContent = new Date().getFullYear();
    }
});
