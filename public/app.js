const socket = io();

const authModal = document.getElementById("auth-modal");
const openAuthButtons = [
  document.getElementById("open-auth"),
  document.getElementById("open-auth-portal"),
];
const closeAuthButton = document.getElementById("close-auth");
const tabs = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");
const signupForm = document.getElementById("signup-form");
const loginForm = document.getElementById("login-form");
const talentFeed = document.getElementById("talent-feed");
const clientDashboard = document.getElementById("client-dashboard");
const refreshFeedButton = document.getElementById("refresh-feed");

let currentToken = localStorage.getItem("workit-token");
let currentRole = localStorage.getItem("workit-role");
let currentProfile = null;

const openModal = () => authModal.classList.add("active");
const closeModal = () => authModal.classList.remove("active");

openAuthButtons.forEach((btn) => btn.addEventListener("click", openModal));
closeAuthButton.addEventListener("click", closeModal);

window.addEventListener("click", (event) => {
  if (event.target === authModal) closeModal();
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((item) => item.classList.remove("active"));
    tabPanels.forEach((panel) => panel.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
  });
});

const api = async (path, options = {}) => {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (currentToken) {
    headers.Authorization = `Bearer ${currentToken}`;
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Request failed");
  }
  return response.json();
};

const renderFeed = async () => {
  if (!currentToken) {
    talentFeed.innerHTML = `<div class="card"><h4>Sign in to see the live feed.</h4><small>Your job feed updates in real time after login.</small></div>`;
    return;
  }
  const jobs = await api("/api/jobs");
  if (!jobs.length) {
    talentFeed.innerHTML = `<div class="card"><h4>No openings yet.</h4><small>Clients will post roles here as they go live.</small></div>`;
    return;
  }
  talentFeed.innerHTML = jobs
    .map((job) => {
      const skillMismatch =
        currentProfile?.role === "talent" &&
        currentProfile?.skills &&
        !currentProfile.skills.toLowerCase().includes(job.interest.toLowerCase());
      return `
      <div class="card">
        <h4>${job.title}</h4>
        <small>Client: ${job.client_name} · Interest: ${job.interest}</small>
        <p>${job.description}</p>
        <span>Budget: ${job.budget}</span>
        ${
          skillMismatch
            ? `<p class="warn">Your skills don't match this interest. You can still apply if you want to try your luck.</p>`
            : ""
        }
        ${
          currentProfile?.role === "talent"
            ? `<button class="secondary" data-apply="${job.id}">Apply</button>`
            : ""
        }
      </div>
    `;
    })
    .join("");

  document.querySelectorAll("[data-apply]").forEach((button) => {
    button.addEventListener("click", async () => {
      const jobId = button.dataset.apply;
      await api("/api/applications", {
        method: "POST",
        body: JSON.stringify({ jobId, coverNote: "Ready to contribute." }),
      });
      button.textContent = "Applied";
      button.disabled = true;
    });
  });
};

const renderDashboard = async () => {
  if (!currentToken || currentRole !== "client") {
    clientDashboard.innerHTML = `<div class="card"><h4>Client dashboard</h4><small>Log in as a client to manage openings and contracts.</small></div>`;
    return;
  }
  const data = await api("/api/client/dashboard");
  const jobList = data.jobs
    .map(
      (job) => `
      <div class="card">
        <h4>${job.title}</h4>
        <small>Status: ${job.status}</small>
        <p>${job.description}</p>
        <span>Interest: ${job.interest}</span>
      </div>`
    )
    .join("");

  const applicationList = data.applications
    .map(
      (app) => `
      <div class="card">
        <h4>${app.talent_name}</h4>
        <small>${app.job_title} · Skills: ${app.talent_skills || "Not provided"}</small>
        <p>${app.cover_note || "No cover note"}</p>
        <button class="secondary" data-contract="${app.id}">Start contract</button>
      </div>`
    )
    .join("");

  const contractList = data.contracts
    .map(
      (contract) => `
      <div class="card">
        <h4>${contract.talent_name}</h4>
        <small>${contract.job_title} · Status: ${contract.status}</small>
        <p>Next pay date: ${new Date(contract.next_payment_date).toLocaleDateString()}</p>
        <button class="secondary" data-hold="${contract.id}">Put on hold</button>
        <button class="ghost" data-terminate="${contract.id}">Terminate</button>
      </div>`
    )
    .join("");

  clientDashboard.innerHTML = `
    <div class="card">
      <h4>Openings</h4>
      ${jobList || "<small>No job openings yet.</small>"}
    </div>
    <div class="card">
      <h4>Applications</h4>
      ${applicationList || "<small>No applications yet.</small>"}
    </div>
    <div class="card">
      <h4>Contracts</h4>
      ${contractList || "<small>No contracts yet.</small>"}
    </div>
  `;

  document.querySelectorAll("[data-contract]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/contracts", {
        method: "POST",
        body: JSON.stringify({ applicationId: button.dataset.contract }),
      });
      renderDashboard();
    });
  });

  document.querySelectorAll("[data-hold]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/contracts/${button.dataset.hold}/hold`, { method: "POST" });
      renderDashboard();
    });
  });

  document.querySelectorAll("[data-terminate]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/contracts/${button.dataset.terminate}/terminate`, { method: "POST" });
      renderDashboard();
    });
  });
};

const loadProfile = async () => {
  if (!currentToken) return;
  currentProfile = await api("/api/profile");
  currentRole = currentProfile.role;
  localStorage.setItem("workit-role", currentRole);
};

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(signupForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    currentToken = data.token;
    localStorage.setItem("workit-token", currentToken);
    await loadProfile();
    closeModal();
    renderFeed();
    renderDashboard();
  } catch (error) {
    alert(error.message);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    currentToken = data.token;
    localStorage.setItem("workit-token", currentToken);
    await loadProfile();
    closeModal();
    renderFeed();
    renderDashboard();
  } catch (error) {
    alert(error.message);
  }
});

refreshFeedButton.addEventListener("click", () => {
  renderFeed();
  renderDashboard();
});

document.querySelectorAll("[data-scroll]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(button.dataset.scroll).scrollIntoView({ behavior: "smooth" });
  });
});

socket.on("job:new", () => {
  renderFeed();
});

socket.on("application:new", () => {
  renderDashboard();
});

socket.on("contract:new", () => {
  renderDashboard();
});

const boot = async () => {
  if (currentToken) {
    await loadProfile();
  }
  renderFeed();
  renderDashboard();
};

boot();
