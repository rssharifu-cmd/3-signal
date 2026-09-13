/* Sharflow — client application */

const STORAGE = {
  lock: "signal_lock_until",
  profile: "signal_profile",
  msgs: "signal_messages",
  email: "signal_email",
  profileForm: "signal_profile_form",
  plan: "signal_plan",
  token: "signal_jwt_token",
  lastDigest: "signal_last_digest",
  lastDigestDate: "signal_last_digest_date",
  emailDigest: "signal_email_digest_on",
};

const LEGACY_LOCK = "digest_locked";
const LEGACY_ANSWERS = "digest_answers";

let profileFormData = {};
let onboardStep = 1;
const ONBOARD_STEPS = 5;
let lockCountdownTimer = null;
let userMemory = null;

// ── Utils ───────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatBotHtml(t) {
  const escaped = escapeHtml(t);
  const urlRegex = /(https?:\/\/[^\s<>\(\)\[\]"']+)/g;
  const formatted = escaped.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="digest-link">${url}</a>`;
  });
  return formatted.replace(/\n/g, "<br/>");
}

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 4200);
}

function getSavedForm() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE.profileForm) || "{}");
  } catch {
    return {};
  }
}

function authHeaders() {
  const token = localStorage.getItem(STORAGE.token) || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function applyUserToLocalState(user) {
  if (!user) return;
  if (user.name) {
    const form = getSavedForm();
    form.name = user.name;
    localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));
  }
  if (user.plan) localStorage.setItem(STORAGE.plan, user.plan);
  if (user.profile?.summary) localStorage.setItem(STORAGE.profile, user.profile.summary);
  if (user.profile?.lockedUntil) {
    localStorage.setItem(STORAGE.lock, user.profile.lockedUntil);
  }
  if (user.profile) {
    const existing = getSavedForm();
    localStorage.setItem(
      STORAGE.profileForm,
      JSON.stringify({
        name: user.name || existing.name || "",
        websiteUrl: user.profile.websiteUrl || existing.websiteUrl || "",
        websiteType: user.profile.websiteType || existing.websiteType || "",
        websitePurpose: user.profile.websitePurpose || existing.websitePurpose || "",
        monitoringPriorities: user.profile.monitoringPriorities || existing.monitoringPriorities || [],
        importantPages: user.profile.importantPages || existing.importantPages || [],
        profession: user.profile.profession || existing.profession || "",
        goals: user.profile.goals || existing.goals || "",
        topics: user.profile.topics || existing.topics || "",
        avoid: user.profile.avoid || existing.avoid || "",
        customSources: user.profile.customSources || existing.customSources || "",
        language: user.profile.language || existing.language || "English",
        country: user.profile.country || existing.country || "United States",
        newsScope: user.profile.newsScope || existing.newsScope || "Website Performance",
        digestLength: user.profile.digestLength || existing.digestLength || "Standard",
        digestTime: user.profile.digestTime || existing.digestTime || "08:00",
        timezone: user.profile.timezone || existing.timezone || "UTC",
      })
    );
  }
  if (user.memory) userMemory = user.memory;
}

function routeAfterAuth(user) {
  const prof = user?.profile?.summary || localStorage.getItem(STORAGE.profile);
  if (prof) {
    const lockRaw = user?.profile?.lockedUntil || localStorage.getItem(STORAGE.lock);
    const lockDate = lockRaw ? new Date(lockRaw) : new Date(0);
    showDashboard(lockDate, prof);
    return true;
  }
  showOnboarding();
  return false;
}

async function hydrateSession() {
  const token = localStorage.getItem(STORAGE.token);
  if (!token) return false;

  try {
    const res = await fetch("/api/auth", { headers: authHeaders() });
    if (!res.ok) {
      localStorage.removeItem(STORAGE.token);
      return false;
    }
    const data = await res.json();
    applyUserToLocalState(data.user);
    return routeAfterAuth(data.user);
  } catch {
    return false;
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────
function openAuthModal(tab = "signup") {
  switchAuthTab(tab);
  document.getElementById("auth-modal").classList.add("open");
}

function closeAuthModal() {
  document.getElementById("auth-modal").classList.remove("open");
}

function switchAuthTab(tab) {
  document.getElementById("auth-signup-form").classList.toggle("hidden", tab !== "signup");
  document.getElementById("auth-login-form").classList.toggle("hidden", tab !== "login");
  document.getElementById("tab-signup").classList.toggle("active", tab === "signup");
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
}

async function handleSignup() {
  const name = document.getElementById("auth-name").value.trim();
  const email = document.getElementById("auth-email").value.trim();
  const pass = document.getElementById("auth-pass").value.trim();
  if (!name || !email || !pass) {
    toast("Please fill in all fields.");
    return;
  }
  if (pass.length < 6) {
    toast("Password must be at least 6 characters.");
    return;
  }

  const btn = document.querySelector("#auth-signup-form .btn-primary");
  btn.disabled = true;
  btn.textContent = "Creating account…";

  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "signup", email, password: pass, name }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Signup failed");
      return;
    }
    localStorage.setItem(STORAGE.token, data.token);
    localStorage.setItem(STORAGE.email, email);
    document.getElementById("pf-name").value = name;
    closeAuthModal();
    showOnboarding();
  } catch {
    toast("Network error — try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Account →";
  }
}

async function handleLogin() {
  const email = document.getElementById("login-email").value.trim();
  const pass = document.getElementById("login-pass").value.trim();
  if (!email || !pass) {
    toast("Please enter email and password.");
    return;
  }

  const btn = document.querySelector("#auth-login-form .btn-primary");
  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", email, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Login failed");
      return;
    }

    localStorage.setItem(STORAGE.token, data.token);
    localStorage.setItem(STORAGE.email, email);
    applyUserToLocalState(data.user);

    closeAuthModal();
    routeAfterAuth(data.user);
  } catch {
    toast("Network error — try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In →";
  }
}

// ── Structured Website Watchdog Onboarding ──────────────────────────────────
const WEBSITE_TYPES = [
  "Business / Company",
  "E-commerce / Online Store",
  "SaaS / Web App",
  "Blog / Content",
  "News / Publisher",
  "Agency / Services",
  "Portfolio / Personal",
  "Community / Membership",
  "Other",
];

const WEBSITE_PURPOSES = [
  "Generate leads",
  "Sell products",
  "Get signups",
  "Get bookings or inquiries",
  "Grow organic traffic",
  "Publish content",
  "Showcase a business",
  "Other",
];

const MONITORING_PRIORITIES = [
  "Search visibility",
  "Traffic changes",
  "Important pages",
  "Technical / indexing problems",
  "Leads / conversions",
  "Content opportunities",
  "All important changes",
];

let onboardingData = {
  websiteUrl: "",
  websiteType: "",
  websitePurpose: "",
  monitoringPriorities: [],
  importantPages: [],
};

let currentOnboardStep = 1;

function showOnboarding() {
  document.getElementById("landing-view").classList.add("hidden");
  document.getElementById("app-shell").style.display = "flex";
  document.getElementById("phase-label").textContent = "Setup";
  document.getElementById("onboarding-view").classList.remove("hidden");
  document.getElementById("dashboard-view").classList.add("hidden");

  // Pre-seed from existing form or reset
  const saved = getSavedForm();
  onboardingData = {
    websiteUrl: saved.websiteUrl || "",
    websiteType: saved.websiteType || "",
    websitePurpose: saved.websitePurpose || "",
    monitoringPriorities: Array.isArray(saved.monitoringPriorities) ? [...saved.monitoringPriorities] : [],
    importantPages: Array.isArray(saved.importantPages) ? [...saved.importantPages] : [],
  };

  const urlInput = document.getElementById("ob-website-url");
  if (urlInput) urlInput.value = onboardingData.websiteUrl;

  renderTypeOptions();
  renderPurposeOptions();
  renderPriorityOptions();

  const pagesInput = document.getElementById("ob-important-pages");
  if (pagesInput) pagesInput.value = onboardingData.importantPages.join("\n");

  goToOnboardStep(1);
}

function updateOnboardProgress(stepNum) {
  const progressBar = document.getElementById("onboard-progress-bar");
  const stepLabel = document.getElementById("onboard-step-indicator");
  if (!progressBar || !stepLabel) return;

  const pct = stepNum === 1 ? 20
            : stepNum === 2 ? 40
            : stepNum === 3 ? 60
            : stepNum === 4 ? 80
            : stepNum === 5 ? 95
            : 100;

  progressBar.style.width = `${pct}%`;
  stepLabel.textContent = stepNum <= 5 ? `Step ${stepNum} of 5` : "Review & Confirm";
}

function goToOnboardStep(stepNum) {
  currentOnboardStep = stepNum;
  updateOnboardProgress(stepNum);

  for (let i = 1; i <= 6; i++) {
    const stepEl = document.getElementById(`onboard-step-${i}`);
    if (stepEl) {
      stepEl.classList.toggle("active", i === stepNum);
    }
  }

  const wrap = document.getElementById("onboarding-view");
  if (wrap) wrap.scrollTop = 0;

  if (stepNum === 1) {
    validateStep1();
    setTimeout(() => {
      const el = document.getElementById("ob-website-url");
      if (el) el.focus();
    }, 100);
  } else if (stepNum === 2) {
    updateTypeContinueButton();
  } else if (stepNum === 3) {
    updatePurposeContinueButton();
  } else if (stepNum === 4) {
    updatePriorityContinueButton();
  } else if (stepNum === 6) {
    renderConfirmationStep();
  }
}

function isValidUrlOrDomain(val) {
  if (!val) return false;
  const clean = val.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
  return /^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(:\d+)?$/.test(clean) || /^https?:\/\/[^\s]+$/.test(val.trim());
}

function validateStep1() {
  const input = document.getElementById("ob-website-url");
  const err = document.getElementById("ob-url-error");
  const btn = document.getElementById("btn-step-1");
  if (!input) return false;

  const val = input.value.trim();
  const valid = isValidUrlOrDomain(val);

  if (btn) btn.disabled = !valid;
  if (err && val.length > 3) {
    err.style.display = valid ? "none" : "block";
  } else if (err) {
    err.style.display = "none";
  }
  return valid;
}

function handleStep1Key(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (validateStep1()) {
      nextOnboardStep(2);
    }
  }
}

function renderTypeOptions() {
  const container = document.getElementById("type-options");
  if (!container) return;
  container.innerHTML = "";

  WEBSITE_TYPES.forEach((type) => {
    const card = document.createElement("div");
    card.className = "select-card radio";
    card.setAttribute("data-value", type);
    const isSelected = onboardingData.websiteType === type || 
      (type === "Other" && onboardingData.websiteType && !WEBSITE_TYPES.slice(0, -1).includes(onboardingData.websiteType));
    
    if (isSelected) card.classList.add("selected");

    card.innerHTML = `
      <span>${type}</span>
      <span class="card-check">●</span>
    `;
    card.onclick = () => selectWebsiteType(type);
    container.appendChild(card);
  });
}

function selectWebsiteType(type) {
  const otherWrap = document.getElementById("type-other-wrap");
  const otherInput = document.getElementById("ob-type-other");

  if (type === "Other") {
    if (otherWrap) otherWrap.style.display = "block";
    const customVal = otherInput ? otherInput.value.trim() : "";
    onboardingData.websiteType = customVal || "Other";
    if (otherInput) otherInput.focus();
  } else {
    if (otherWrap) otherWrap.style.display = "none";
    onboardingData.websiteType = type;
  }

  document.querySelectorAll("#type-options .select-card").forEach((c) => {
    c.classList.toggle("selected", c.getAttribute("data-value") === type);
  });

  updateTypeContinueButton();
}

function handleTypeOtherInput() {
  const input = document.getElementById("ob-type-other");
  if (!input) return;
  onboardingData.websiteType = input.value.trim() || "Other";
  updateTypeContinueButton();
}

function updateTypeContinueButton() {
  const btn = document.getElementById("btn-step-2");
  if (btn) {
    btn.disabled = !onboardingData.websiteType;
  }
}

function renderPurposeOptions() {
  const container = document.getElementById("purpose-options");
  if (!container) return;
  container.innerHTML = "";

  WEBSITE_PURPOSES.forEach((purpose) => {
    const card = document.createElement("div");
    card.className = "select-card radio";
    card.setAttribute("data-value", purpose);
    const isSelected = onboardingData.websitePurpose === purpose ||
      (purpose === "Other" && onboardingData.websitePurpose && !WEBSITE_PURPOSES.slice(0, -1).includes(onboardingData.websitePurpose));

    if (isSelected) card.classList.add("selected");

    card.innerHTML = `
      <span>${purpose}</span>
      <span class="card-check">●</span>
    `;
    card.onclick = () => selectWebsitePurpose(purpose);
    container.appendChild(card);
  });
}

function selectWebsitePurpose(purpose) {
  const otherWrap = document.getElementById("purpose-other-wrap");
  const otherInput = document.getElementById("ob-purpose-other");

  if (purpose === "Other") {
    if (otherWrap) otherWrap.style.display = "block";
    const customVal = otherInput ? otherInput.value.trim() : "";
    onboardingData.websitePurpose = customVal || "Other";
    if (otherInput) otherInput.focus();
  } else {
    if (otherWrap) otherWrap.style.display = "none";
    onboardingData.websitePurpose = purpose;
  }

  document.querySelectorAll("#purpose-options .select-card").forEach((c) => {
    c.classList.toggle("selected", c.getAttribute("data-value") === purpose);
  });

  updatePurposeContinueButton();
}

function handlePurposeOtherInput() {
  const input = document.getElementById("ob-purpose-other");
  if (!input) return;
  onboardingData.websitePurpose = input.value.trim() || "Other";
  updatePurposeContinueButton();
}

function updatePurposeContinueButton() {
  const btn = document.getElementById("btn-step-3");
  if (btn) {
    btn.disabled = !onboardingData.websitePurpose;
  }
}

function renderPriorityOptions() {
  const container = document.getElementById("priority-options");
  if (!container) return;
  container.innerHTML = "";

  MONITORING_PRIORITIES.forEach((priority) => {
    const card = document.createElement("div");
    card.className = "select-card";
    card.setAttribute("data-value", priority);
    const isSelected = onboardingData.monitoringPriorities.includes(priority);
    if (isSelected) card.classList.add("selected");

    card.innerHTML = `
      <span>${priority}</span>
      <span class="card-check">✓</span>
    `;
    card.onclick = () => toggleMonitoringPriority(priority);
    container.appendChild(card);
  });
}

function toggleMonitoringPriority(priority) {
  if (priority === "All important changes") {
    if (onboardingData.monitoringPriorities.includes("All important changes")) {
      onboardingData.monitoringPriorities = [];
    } else {
      onboardingData.monitoringPriorities = [...MONITORING_PRIORITIES];
    }
  } else {
    const idx = onboardingData.monitoringPriorities.indexOf(priority);
    if (idx >= 0) {
      onboardingData.monitoringPriorities.splice(idx, 1);
      const allIdx = onboardingData.monitoringPriorities.indexOf("All important changes");
      if (allIdx >= 0) onboardingData.monitoringPriorities.splice(allIdx, 1);
    } else {
      onboardingData.monitoringPriorities.push(priority);
      const nonAll = MONITORING_PRIORITIES.filter((p) => p !== "All important changes");
      const hasAllIndividual = nonAll.every((p) => onboardingData.monitoringPriorities.includes(p));
      if (hasAllIndividual && !onboardingData.monitoringPriorities.includes("All important changes")) {
        onboardingData.monitoringPriorities.push("All important changes");
      }
    }
  }

  document.querySelectorAll("#priority-options .select-card").forEach((c) => {
    const val = c.getAttribute("data-value");
    c.classList.toggle("selected", onboardingData.monitoringPriorities.includes(val));
  });

  updatePriorityContinueButton();
}

function updatePriorityContinueButton() {
  const btn = document.getElementById("btn-step-4");
  if (btn) {
    btn.disabled = onboardingData.monitoringPriorities.length === 0;
  }
}

function skipStep5() {
  onboardingData.importantPages = [];
  const el = document.getElementById("ob-important-pages");
  if (el) el.value = "";
  goToOnboardStep(6);
}

function nextOnboardStep(targetStep) {
  if (targetStep === 2) {
    const input = document.getElementById("ob-website-url");
    const val = input ? input.value.trim() : "";
    if (!isValidUrlOrDomain(val)) {
      const err = document.getElementById("ob-url-error");
      if (err) err.style.display = "block";
      if (input) input.focus();
      return;
    }
    let cleanUrl = val.replace(/^https?:\/\//i, "").trim();
    cleanUrl = cleanUrl.replace(/\/+$/, "");
    onboardingData.websiteUrl = cleanUrl;
  } else if (targetStep === 3) {
    if (!onboardingData.websiteType) {
      toast("Please select a website type");
      return;
    }
  } else if (targetStep === 4) {
    if (!onboardingData.websitePurpose) {
      toast("Please select the main job of this website");
      return;
    }
  } else if (targetStep === 5) {
    if (onboardingData.monitoringPriorities.length === 0) {
      onboardingData.monitoringPriorities = ["All important changes"];
      renderPriorityOptions();
    }
  } else if (targetStep === 6) {
    const input = document.getElementById("ob-important-pages");
    if (input && input.value.trim()) {
      onboardingData.importantPages = input.value
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter(Boolean);
    } else {
      onboardingData.importantPages = [];
    }
  }

  goToOnboardStep(targetStep);
}

function prevOnboardStep(targetStep) {
  goToOnboardStep(targetStep);
}

function renderConfirmationStep() {
  const siteEl = document.getElementById("confirm-website");
  const typeEl = document.getElementById("confirm-type");
  const purposeEl = document.getElementById("confirm-purpose");
  const prioEl = document.getElementById("confirm-priorities");
  const pagesEl = document.getElementById("confirm-pages");

  if (siteEl) siteEl.textContent = onboardingData.websiteUrl || "—";
  if (typeEl) typeEl.textContent = onboardingData.websiteType || "—";
  if (purposeEl) purposeEl.textContent = onboardingData.websitePurpose || "—";

  if (prioEl) {
    prioEl.innerHTML = "";
    const list = onboardingData.monitoringPriorities.length > 0
      ? onboardingData.monitoringPriorities
      : ["All important changes"];
    list.forEach((p) => {
      const pill = document.createElement("span");
      pill.className = "meta-pill";
      pill.textContent = p;
      prioEl.appendChild(pill);
    });
  }

  if (pagesEl) {
    if (onboardingData.importantPages.length > 0) {
      pagesEl.textContent = onboardingData.importantPages.join(", ");
    } else {
      pagesEl.textContent = "None specified";
    }
  }
}

function buildWebsiteSummaryText(data) {
  const lines = [
    `Website: ${data.websiteUrl}`,
    `Type: ${data.websiteType}`,
    `Main goal: ${data.websitePurpose}`,
    `Watching for: ${(data.monitoringPriorities || []).join(", ") || "All important changes"}`,
  ];
  if (data.importantPages && data.importantPages.length > 0) {
    lines.push(`Important pages: ${data.importantPages.join(", ")}`);
  }
  return lines.join("\n");
}

async function submitWebsiteOnboarding() {
  const btn = document.getElementById("btn-confirm-onboard");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Setting up Watchdog…";
  }

  const summaryText = buildWebsiteSummaryText(onboardingData);
  const lockUntil = new Date();
  lockUntil.setDate(lockUntil.getDate() + 7);

  const form = {
    name: localStorage.getItem(STORAGE.email)?.split("@")[0] || "User",
    websiteUrl: onboardingData.websiteUrl,
    websiteType: onboardingData.websiteType,
    websitePurpose: onboardingData.websitePurpose,
    monitoringPriorities: onboardingData.monitoringPriorities,
    importantPages: onboardingData.importantPages,
    summary: summaryText,
    profession: `${onboardingData.websiteType} Owner`,
    goals: onboardingData.websitePurpose,
    topics: (onboardingData.monitoringPriorities || []).join(", ") || "Website performance, SEO, search traffic",
    avoid: "Broken tracking, vanity metrics without impact",
    customSources: onboardingData.websiteUrl,
    language: "English",
    country: "United States",
    newsScope: "Website Performance",
    digestLength: "Standard",
    tone: "concise",
    digestTime: "08:00",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };

  localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));
  localStorage.setItem(STORAGE.profile, summaryText);
  localStorage.setItem(STORAGE.lock, lockUntil.toISOString());

  const savedEmail = localStorage.getItem(STORAGE.email) || "";
  const token = localStorage.getItem(STORAGE.token) || "";

  if (savedEmail) {
    try {
      await fetch("/api/user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: form.name,
          plan: localStorage.getItem(STORAGE.plan) || "starter",
          lockedUntil: lockUntil.toISOString(),
          profile: {
            websiteUrl: form.websiteUrl,
            websiteType: form.websiteType,
            websitePurpose: form.websitePurpose,
            monitoringPriorities: form.monitoringPriorities,
            importantPages: form.importantPages,
            summary: summaryText,
            profession: form.profession,
            goals: form.goals,
            topics: form.topics,
            avoid: form.avoid,
            customSources: form.customSources,
            language: form.language,
            country: form.country,
            newsScope: form.newsScope,
            digestLength: form.digestLength,
            tone: form.tone,
            digestTime: form.digestTime,
            timezone: form.timezone,
          },
        }),
      });

      // Send welcome email if enabled
      fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "welcome",
          email: savedEmail,
          name: form.name,
          profileSummary: summaryText,
          unlockDate: lockUntil.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        }),
      }).catch((e) => console.warn("Welcome email send error:", e));
    } catch (err) {
      console.warn("Saving profile to DB failed:", err);
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Continue to Watchdog →";
  }

  toast("Your Watchdog profile is ready");
  showDashboard(lockUntil, summaryText);
  generateDashboardDigest(true);
}

function digestLengthToTone(length) {
  if (length === "Quick") return "concise";
  if (length === "Deep") return "detailed";
  return "";
}

function buildProfileSummaryText(form) {
  return [
    `Role: ${form.profession || "—"}`,
    `Goal: ${form.goals || "—"}`,
    `Topics: ${form.topics || "—"}`,
    `Language: ${form.language || "English"}`,
    `Country: ${form.country || "—"}`,
    `News scope: ${form.newsScope || "Mixed"}`,
    `Digest length: ${form.digestLength || "Standard"}`,
    form.avoid ? `Avoid: ${form.avoid}` : null,
    form.customSources ? `Favorite sources: ${form.customSources}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function apiChat(body) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(raw.slice(0, 180) || "Invalid JSON");
  }
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  if (["chat", "summary", "digest"].includes(body.action)) {
    if (typeof data.content !== "string" || !data.content.trim()) {
      throw new Error(data.error || "Empty reply from AI.");
    }
  }
  return data;
}

async function apiNews(form) {
  const res = await fetch("/api/news", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topics: form.topics || "technology, AI",
      profession: form.profession || "",
      avoid: form.avoid || "",
    }),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(raw.slice(0, 180) || "Invalid JSON");
  }
  if (!res.ok) throw new Error(data.error || "News fetch failed");
  return data;
}

function buildNewsContext(news) {
  if (!news?.ok) return "";
  const t = news.text || {};
  return [
    "ARTICLES:",
    t.articles || "None",
    "",
    "REDDIT:",
    t.reddit || "None",
    "",
    "VIDEO:",
    t.video || "None",
  ].join("\n");
}

async function fetchPersonalizedDigest({ showToastOnFetch = false } = {}) {
  const profileText = localStorage.getItem(STORAGE.profile) || "";
  const form = getSavedForm();
  const plan = localStorage.getItem(STORAGE.plan) || "starter";

  let newsContext = "";
  let sourceNote = "";

  try {
    if (showToastOnFetch) toast("Fetching live sources for your topics…");
    const news = await apiNews(form);
    newsContext = buildNewsContext(news);
    const c = news.counts || {};
    sourceNote = `${c.total || 0} items · Tavily ${c.tavily || 0} · RSS ${c.rss || 0} · Reddit ${c.reddit || 0}${c.video ? " · Video" : ""}`;
    if (showToastOnFetch) toast("Personalizing your digest…");
  } catch (e) {
    console.warn("News fetch:", e.message);
    sourceNote = "Profile-only (news API unavailable)";
  }

  const data = await apiChat({
    action: "digest",
    profile: {
      narrative: profileText,
      profession: form.profession,
      goals: form.goals,
      topics: form.topics,
      avoid: form.avoid,
      tone: form.tone,
      language: form.language,
      country: form.country,
      newsScope: form.newsScope,
      digestLength: form.digestLength,
    },
    memory: userMemory,
    plan,
    newsContext,
  });

  const today = new Date().toISOString().split("T")[0];
  localStorage.setItem(STORAGE.lastDigest, data.content);
  localStorage.setItem(STORAGE.lastDigestDate, today);

  return { content: data.content, sourceNote };
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function showDashboard(lockDate, profileText, email) {
  document.getElementById("landing-view").classList.add("hidden");
  document.getElementById("app-shell").style.display = "flex";
  document.getElementById("onboarding-view").classList.add("hidden");
  document.getElementById("dashboard-view").classList.remove("hidden");
  document.getElementById("phase-label").textContent = "Dashboard";

  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const form = getSavedForm();
  const name = form.name ? `, ${form.name.split(" ")[0]}` : "";
  document.getElementById("dash-greeting").textContent = greet + name;

  // Website details
  const dpWebsite = document.getElementById("dp-website");
  if (dpWebsite) dpWebsite.textContent = form.websiteUrl || form.customSources || "—";
  const dpType = document.getElementById("dp-type");
  if (dpType) dpType.textContent = form.websiteType || form.profession || "—";
  const dpGoal = document.getElementById("dp-goal");
  if (dpGoal) dpGoal.textContent = form.websitePurpose || form.goals || "—";

  // Legacy/fallback elements
  const dpProf = document.getElementById("dp-profession");
  if (dpProf) dpProf.textContent = form.profession || form.websiteType || "—";
  const dpScope = document.getElementById("dp-scope");
  if (dpScope) dpScope.textContent = form.newsScope || "Website Performance";
  const dpAvoid = document.getElementById("dp-avoid");
  if (dpAvoid) dpAvoid.textContent = form.avoid || "—";
  const dpLength = document.getElementById("dp-length");
  if (dpLength) dpLength.textContent = form.digestLength || "Standard";
  const dpRegion = document.getElementById("dp-region");
  if (dpRegion) dpRegion.textContent = [form.language, form.country].filter(Boolean).join(" · ") || "—";
  const dpSources = document.getElementById("dp-sources");
  if (dpSources) dpSources.textContent = form.customSources || form.websiteUrl || "Default curated feeds";

  const pagesEl = document.getElementById("dp-pages");
  if (pagesEl) {
    const pages = Array.isArray(form.importantPages) && form.importantPages.length > 0
      ? form.importantPages.join(", ")
      : (typeof form.importantPages === "string" && form.importantPages ? form.importantPages : "None specified");
    pagesEl.textContent = pages;
  }

  const tagsEl = document.getElementById("dp-tags");
  if (tagsEl) {
    tagsEl.innerHTML = "";
    const priorityList = (Array.isArray(form.monitoringPriorities) && form.monitoringPriorities.length > 0)
      ? form.monitoringPriorities
      : (form.topics || "Search visibility, Traffic changes").split(",").map((t) => t.trim()).filter(Boolean);
    priorityList.slice(0, 8).forEach((t) => {
      const tag = document.createElement("span");
      tag.className = "profile-tag";
      tag.textContent = t;
      tagsEl.appendChild(tag);
    });
  }

  syncProfilePanels();
  startLockCountdown(lockDate);
  renderCachedDigest();
  if (profileText) localStorage.setItem(STORAGE.profile, profileText);
}

function syncProfilePanels() {
  const form = getSavedForm();
  
  const dpWebsite2 = document.getElementById("dp-website-2");
  if (dpWebsite2) dpWebsite2.textContent = form.websiteUrl || form.customSources || "—";
  const dpType2 = document.getElementById("dp-type-2");
  if (dpType2) dpType2.textContent = form.websiteType || form.profession || "—";
  const dpGoal2 = document.getElementById("dp-goal-2");
  if (dpGoal2) dpGoal2.textContent = form.websitePurpose || form.goals || "—";

  const pagesEl2 = document.getElementById("dp-pages-2");
  if (pagesEl2) {
    const pages = Array.isArray(form.importantPages) && form.importantPages.length > 0
      ? form.importantPages.join(", ")
      : (typeof form.importantPages === "string" && form.importantPages ? form.importantPages : "None specified");
    pagesEl2.textContent = pages;
  }

  const summaryEl2 = document.getElementById("dp-summary-2");
  if (summaryEl2) {
    summaryEl2.textContent = localStorage.getItem(STORAGE.profile) || form.summary || "—";
  }

  const pairs = [
    ["dp-profession", "dp-profession-2", form.profession || form.websiteType],
    ["dp-goal", "dp-goal-2", form.goals || form.websitePurpose],
    ["dp-scope", "dp-scope-2", form.newsScope],
    ["dp-length", "dp-length-2", form.digestLength],
    ["dp-avoid", "dp-avoid-2", form.avoid],
  ];
  pairs.forEach(([, to, val]) => {
    const el = document.getElementById(to);
    if (el) el.textContent = val || "—";
  });
  const langEl = document.getElementById("dp-language");
  const countryEl = document.getElementById("dp-country");
  if (langEl) langEl.textContent = form.language || "—";
  if (countryEl) countryEl.textContent = form.country || "—";
  const tags = document.getElementById("dp-tags");
  const tags2 = document.getElementById("dp-tags-2");
  if (tags && tags2) tags2.innerHTML = tags.innerHTML;
}

function syncDigestPanels() {
  const out = document.getElementById("digest-output");
  const full = document.getElementById("digest-output-full");
  const note = document.getElementById("digest-source-note");
  const noteFull = document.getElementById("digest-source-note-full");
  if (full && out) {
    full.className = out.className;
    full.innerHTML = out.innerHTML;
    wireDigestFeedback(full);
  }
  if (noteFull && note) noteFull.textContent = note.textContent;
}

function startLockCountdown(lockDate) {
  if (lockCountdownTimer) clearInterval(lockCountdownTimer);
  const el = document.getElementById("lock-countdown");
  const pill = el?.closest(".meta-pill");

  function tick() {
    const diff = lockDate - new Date();
    if (diff <= 0) {
      el.textContent = "Unlocked — you can refine your profile";
      if (pill) {
        pill.classList.remove("amber");
        pill.classList.add("green");
      }
      clearInterval(lockCountdownTimer);
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    el.textContent = d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
  }
  tick();
  lockCountdownTimer = setInterval(tick, 60000);
}

function extractStoryTopic(title) {
  const cleaned = (title || "").replace(/^[①②③④⑤]\s*/, "").trim();
  const words = cleaned.split(/\s+/).slice(0, 4).join(" ");
  return words || cleaned;
}

function renderDigestHtml(content) {
  if (!content) return "";

  const lines = content.split("\n");
  let html = "";
  let storyBuf = [];
  let storyTitle = "";
  let inStories = false;
  let storyIndex = 0;

  function flushStory() {
    if (!storyTitle && !storyBuf.length) return;
    const topic = extractStoryTopic(storyTitle);
    const body = storyBuf.map((l) => formatBotHtml(l)).join("<br/>");
    const sid = `story-${storyIndex++}`;
    const safeTopic = escapeHtml(topic);
    const safeTitle = escapeHtml(storyTitle);
    html += `<div class="digest-story" data-topic="${safeTopic}">
      <div class="digest-story-title">${formatBotHtml(storyTitle)}</div>
      <div class="digest-story-body">${body}</div>
      <div class="digest-feedback">
        <span>Relevant?</span>
        <button type="button" class="fb-btn" data-topic="${safeTopic}" data-title="${safeTitle}" data-sentiment="like">👍 More like this</button>
        <button type="button" class="fb-btn" data-topic="${safeTopic}" data-title="${safeTitle}" data-sentiment="dislike">👎 Less like this</button>
      </div>
    </div>`;
    storyBuf = [];
    storyTitle = "";
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^🔥|^💡|^📺|^━/.test(trimmed) || trimmed === "") {
      if (/^①|^②|^③|^④|^⑤/.test(storyTitle)) flushStory();
      if (trimmed) html += `<div style="margin:12px 0 8px;font-weight:700;">${formatBotHtml(trimmed)}</div>`;
      inStories = trimmed.startsWith("🔥");
      continue;
    }
    if (/^①|^②|^③|^④|^⑤/.test(trimmed)) {
      flushStory();
      storyTitle = trimmed;
      inStories = true;
      continue;
    }
    if (inStories && storyTitle) {
      storyBuf.push(line);
      continue;
    }
    html += `<div>${formatBotHtml(line)}</div>`;
  }
  flushStory();
  return html || formatBotHtml(content);
}

function wireDigestFeedback(container) {
  if (!container) return;

  // 1. Wire 👍/👎 feedback buttons
  container.querySelectorAll(".fb-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation(); // prevent card-level engagement click from firing
      submitFeedback(btn.dataset.topic, btn.dataset.sentiment, btn.dataset.title, btn);
    };
  });

  // 2. Wire clicked links inside stories (to learn from active clicked links)
  container.querySelectorAll(".digest-link").forEach((link) => {
    link.onclick = (e) => {
      e.stopPropagation(); // prevent duplicate card-level click from firing
      const card = link.closest(".digest-story");
      const topic = card ? (card.dataset.topic || "") : "";
      const titleEl = card ? card.querySelector(".digest-story-title") : null;
      const title = titleEl ? titleEl.textContent : "";
      trackEngagementClick(topic, title, link.href);
    };
  });

  // 3. Wire opened/viewed story card clicks (to learn from clicked/opened articles)
  container.querySelectorAll(".digest-story").forEach((card) => {
    card.onclick = () => {
      const topic = card.dataset.topic || "";
      const titleEl = card.querySelector(".digest-story-title");
      const title = titleEl ? titleEl.textContent : "";
      trackEngagementClick(topic, title, "");
    };
  });
}

function setDigestContent(el, content) {
  if (!el) return;
  el.innerHTML = renderDigestHtml(content);
  wireDigestFeedback(el);
}

async function submitFeedback(topic, sentiment, storyTitle, btn) {
  const row = btn?.closest(".digest-feedback");
  if (row) {
    row.querySelectorAll(".fb-btn").forEach((b) => b.classList.remove("liked", "disliked"));
    btn.classList.add(sentiment === "like" ? "liked" : "disliked");
  }

  try {
    const res = await fetch("/api/user", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ action: "feedback", topic, sentiment, storyTitle }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Feedback failed");
    if (data.memory) userMemory = data.memory;
    toast(sentiment === "like" ? "Got it — we'll show more like this" : "Noted — we'll show less of this");
  } catch (e) {
    toast(e.message || "Could not save feedback");
  }
}

function renderCachedDigest() {
  const el = document.getElementById("digest-output");
  const note = document.getElementById("digest-source-note");
  const content = localStorage.getItem(STORAGE.lastDigest);
  const date = localStorage.getItem(STORAGE.lastDigestDate);

  if (content && date === new Date().toISOString().split("T")[0]) {
    el.className = "digest-content";
    setDigestContent(el, content);
    note.textContent = `Last generated today`;
  } else if (content) {
    el.className = "digest-content";
    setDigestContent(el, content);
    note.textContent = `Cached from ${date} — tap Generate for today's edition`;
  } else {
    el.className = "digest-content empty";
    el.textContent = "No digest yet. Hit Generate to pull live stories matched to your profile.";
    note.textContent = "";
  }
  syncDigestPanels();
}

async function generateDashboardDigest(auto = false) {
  const el = document.getElementById("digest-output");
  const note = document.getElementById("digest-source-note");
  const btn = document.getElementById("btn-generate-digest");

  el.className = "digest-status";
  el.innerHTML = `<div class="spinner"></div><span>Fetching sources and writing your digest…</span>`;
  if (btn) btn.disabled = true;

  try {
    const { content, sourceNote } = await fetchPersonalizedDigest({ showToastOnFetch: !auto });
    el.className = "digest-content";
    setDigestContent(el, content);
    note.textContent = sourceNote;
    window._lastDigestContent = content;
    syncDigestPanels();
    if (!auto) toast("Digest ready — personalized from live sources");
  } catch (e) {
    el.className = "digest-content empty";
    el.textContent = e.message || "Could not generate digest.";
    note.textContent = "";
    syncDigestPanels();
    toast(e.message || "Digest failed");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function sendDigestEmail() {
  const savedEmail = localStorage.getItem(STORAGE.email) || "";
  const form = getSavedForm();
  const content = window._lastDigestContent || localStorage.getItem(STORAGE.lastDigest) || "";
  if (!savedEmail || !content) {
    toast("Sign in with email and generate a digest first.");
    return;
  }
  toast("Sending to " + savedEmail + "…");
  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "digest",
        email: savedEmail,
        name: form.name || "",
        digestContent: content,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Send failed");
    toast("Digest emailed to " + savedEmail);
  } catch (e) {
    toast("Email failed: " + e.message);
  }
}

function dashNav(panel) {
  document.querySelectorAll(".dash-nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.panel === panel);
  });
  document.querySelectorAll(".dash-panel").forEach((p) => {
    p.classList.toggle("hidden", p.id !== `panel-${panel}`);
  });
  if (panel === "settings") {
    loadSettingsIntoDashboard();
  }
}

// ── Reset & init ──────────────────────────────────────────────────────────────
function tryMigrateLegacy() {
  const locked = localStorage.getItem(LEGACY_LOCK);
  const saved = localStorage.getItem(LEGACY_ANSWERS);
  if (!locked || !saved) return false;
  const until = new Date(locked);
  if (until <= new Date()) return false;
  let answers;
  try {
    answers = JSON.parse(saved);
  } catch {
    return false;
  }
  const narrative = ["Profession", "Goal", "Challenge", "Sources", "YouTube", "Delivery", "Email"]
    .map((k) => {
      const v = answers[k.toLowerCase()];
      return v ? `${k}: ${v}` : null;
    })
    .filter(Boolean)
    .join("\n");
  localStorage.setItem(STORAGE.profile, narrative || "Legacy profile");
  localStorage.setItem(STORAGE.lock, locked);
  return true;
}

function resetAll() {
  if (lockCountdownTimer) clearInterval(lockCountdownTimer);
  Object.values(STORAGE).forEach((k) => localStorage.removeItem(k));
  [LEGACY_LOCK, LEGACY_ANSWERS].forEach((k) => localStorage.removeItem(k));
  profileFormData = {};
  userMemory = null;
  document.getElementById("landing-view").classList.remove("hidden");
  document.getElementById("app-shell").style.display = "none";
  toast("Signed out locally — refresh to start over");
}

window.onload = async () => {
  if (tryMigrateLegacy()) {
    showDashboard(new Date(localStorage.getItem(STORAGE.lock)), localStorage.getItem(STORAGE.profile));
    return;
  }

  const hydrated = await hydrateSession();
  if (hydrated) return;

  const prof = localStorage.getItem(STORAGE.profile);
  if (prof) {
    const lock = localStorage.getItem(STORAGE.lock);
    showDashboard(lock ? new Date(lock) : new Date(0), prof);
    return;
  }

  const savedForm = localStorage.getItem(STORAGE.profileForm);
  if (savedForm) {
    try {
      profileFormData = JSON.parse(savedForm);
    } catch {
      profileFormData = {};
    }
  }
};

function loadSettingsIntoDashboard() {
  const form = getSavedForm();
  
  const elTime = document.getElementById("settings-digest-time");
  const elTz = document.getElementById("settings-timezone");
  const elLang = document.getElementById("settings-language");
  const elCountry = document.getElementById("settings-country");
  const elScope = document.getElementById("settings-news-scope");
  const elLength = document.getElementById("settings-digest-length");
  const elAvoid = document.getElementById("settings-avoid");

  if (elTime) elTime.value = form.digestTime || "08:00";
  if (elTz) elTz.value = form.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (elLang) elLang.value = form.language || "English";
  if (elCountry) elCountry.value = form.country || "United States";
  if (elScope) elScope.value = form.newsScope || "Mixed";
  if (elLength) elLength.value = form.digestLength || "Standard";
  if (elAvoid) elAvoid.value = form.avoid || "";
}

async function saveDashboardSettings() {
  const digestTime = document.getElementById("settings-digest-time").value;
  const timezone = document.getElementById("settings-timezone").value;
  const language = document.getElementById("settings-language").value;
  const country = document.getElementById("settings-country").value;
  const newsScope = document.getElementById("settings-news-scope").value;
  const digestLength = document.getElementById("settings-digest-length").value;
  const avoid = document.getElementById("settings-avoid").value;

  const form = getSavedForm();
  form.digestTime = digestTime;
  form.timezone = timezone;
  form.language = language;
  form.country = country;
  form.newsScope = newsScope;
  form.digestLength = digestLength;
  form.avoid = avoid;
  form.tone = digestLengthToTone(digestLength);

  localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));

  const summaryText = buildProfileSummaryText(form);
  localStorage.setItem(STORAGE.profile, summaryText);

  // Sync displayed profile panel labels immediately
  syncProfilePanels();

  const token = localStorage.getItem(STORAGE.token) || "";
  const btn = document.getElementById("btn-save-settings");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }

  try {
    const res = await fetch("/api/user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        profile: {
          summary: summaryText,
          profession: form.profession || "",
          goals: form.goals || "",
          topics: form.topics || "",
          avoid: form.avoid || "",
          customSources: form.customSources || "",
          language: form.language || "English",
          country: form.country || "",
          newsScope: form.newsScope || "Mixed",
          digestLength: form.digestLength || "Standard",
          tone: form.tone || "",
          digestTime: form.digestTime || "08:00",
          timezone: form.timezone || "UTC",
        }
      })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to save settings to database");
    }

    toast("Settings saved to profile ✓");

    // Re-render dashboard overview and fields with the lock dates
    const savedLock = localStorage.getItem(STORAGE.lock);
    const lockDate = savedLock ? new Date(savedLock) : new Date(0);
    showDashboard(lockDate, summaryText);

  } catch (err) {
    toast("Error: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  }
}

async function trackEngagementClick(topic, storyTitle, url) {
  try {
    const token = localStorage.getItem(STORAGE.token) || "";
    const res = await fetch("/api/user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        action: "click",
        topic,
        storyTitle,
        url
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.memory) {
        userMemory = data.memory;
        console.log("[Analytics] Long-term memory engagement registered:", data.memory);
      }
    }
  } catch (err) {
    console.warn("[Analytics] Engagement track ignored:", err.message);
  }
}

// Expose for inline handlers
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthTab = switchAuthTab;
window.handleSignup = handleSignup;
window.handleLogin = handleLogin;
window.showOnboarding = showOnboarding;
window.validateStep1 = validateStep1;
window.handleStep1Key = handleStep1Key;
window.nextOnboardStep = nextOnboardStep;
window.prevOnboardStep = prevOnboardStep;
window.selectWebsiteType = selectWebsiteType;
window.handleTypeOtherInput = handleTypeOtherInput;
window.selectWebsitePurpose = selectWebsitePurpose;
window.handlePurposeOtherInput = handlePurposeOtherInput;
window.toggleMonitoringPriority = toggleMonitoringPriority;
window.skipStep5 = skipStep5;
window.submitWebsiteOnboarding = submitWebsiteOnboarding;
window.generateDashboardDigest = generateDashboardDigest;
window.sendDigestEmail = sendDigestEmail;
window.dashNav = dashNav;
window.resetAll = resetAll;
window.submitFeedback = submitFeedback;
window.loadSettingsIntoDashboard = loadSettingsIntoDashboard;
window.saveDashboardSettings = saveDashboardSettings;
window.trackEngagementClick = trackEngagementClick;
