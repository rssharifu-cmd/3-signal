/* Sharflow — client application */

const STORAGE = {
  lock: "signal_lock_until",
  profile: "signal_profile",
  msgs: "signal_messages",
  email: "signal_email",
  userName: "signal_user_name",
  profileForm: "signal_profile_form",
  plan: "signal_plan",
  token: "signal_jwt_token",
  lastDigest: "signal_last_digest",
  lastDigestDate: "signal_last_digest_date",
  lastWatchdogReport: "signal_last_watchdog_report",
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

function getUserName() {
  const storedName = localStorage.getItem(STORAGE.userName);
  if (storedName && storedName.trim()) return storedName.trim();
  const form = getSavedForm();
  if (form.name && form.name.trim()) return form.name.trim();
  const pfEl = document.getElementById("pf-name");
  if (pfEl && pfEl.value.trim()) return pfEl.value.trim();
  return "";
}

function authHeaders() {
  const token = localStorage.getItem(STORAGE.token) || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function applyUserToLocalState(user) {
  if (!user) return;
  if (user.name && user.name.trim()) {
    localStorage.setItem(STORAGE.userName, user.name.trim());
    const form = getSavedForm();
    form.name = user.name.trim();
    localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));
    const pfName = document.getElementById("pf-name");
    if (pfName) pfName.value = user.name.trim();
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
        ...existing,
        ...user.profile,
        name: user.name || existing.name || localStorage.getItem(STORAGE.userName) || "",
        websiteUrl: user.profile.websiteUrl || existing.websiteUrl || "",
        websiteType: user.profile.websiteType || existing.websiteType || "",
        websitePurpose: user.profile.websitePurpose || existing.websitePurpose || "",
        monitoringPriorities: user.profile.monitoringPriorities || existing.monitoringPriorities || [],
        importantPages: user.profile.importantPages || existing.importantPages || [],
        profession: user.profile.profession || existing.profession || "",
        goals: user.profile.goals || existing.goals || "",
        topics: user.profile.topics || existing.topics || "",
        avoid: user.profile.avoid !== undefined ? user.profile.avoid : (existing.avoid || ""),
        customSources: user.profile.customSources || existing.customSources || "",
        language: user.profile.language || existing.language || "English",
        country: user.profile.country !== undefined ? user.profile.country : (existing.country || "United States"),
        newsScope: user.profile.newsScope || existing.newsScope || "Website Performance",
        digestLength: user.profile.digestLength || existing.digestLength || "Standard",
        tone: user.profile.tone || existing.tone || "concise",
        digestTime: user.profile.digestTime || existing.digestTime || "08:00",
        timezone: user.profile.timezone || existing.timezone || "UTC",
        lockedUntil: user.profile.lockedUntil || existing.lockedUntil || null,
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

// ── Paddle Billing v2 Configuration & Checkout ─────────────────────────────
const SHARFLOW_PRO_PRICE_ID = "pri_01m4tf8w6602rpfrhv9mbrcm7b";

let cachedPaddleConfig = {
  env: "live",
  clientToken: null,
  defaultPriceId: SHARFLOW_PRO_PRICE_ID,
};
let paddleInitialized = false;

async function fetchPaddleConfig() {
  try {
    const res = await fetch("/api/auth?action=config");
    if (res.ok) {
      const data = await res.json();
      if (data.googleClientId) {
        cachedGoogleClientId = data.googleClientId;
      }
      if (data.paddle) {
        cachedPaddleConfig.env = data.paddle.env || cachedPaddleConfig.env;
        cachedPaddleConfig.clientToken = data.paddle.clientToken || cachedPaddleConfig.clientToken;
        if (data.paddle.defaultPriceId) {
          cachedPaddleConfig.defaultPriceId = data.paddle.defaultPriceId;
        }
      }
    }
  } catch (err) {
    console.warn("Could not fetch configuration:", err.message);
  }
}

async function initPaddle() {
  if (paddleInitialized) return true;
  await fetchPaddleConfig();

  // Wait briefly if async Paddle script is loading
  let attempts = 0;
  while (!window.Paddle && attempts < 25) {
    await new Promise((r) => setTimeout(r, 120));
    attempts++;
  }

  if (!window.Paddle) {
    console.warn("Paddle.js library is not available.");
    return false;
  }

  try {
    if (cachedPaddleConfig.env === "sandbox" && window.Paddle.Environment?.set) {
      window.Paddle.Environment.set("sandbox");
    }

    if (cachedPaddleConfig.clientToken && window.Paddle.Initialize) {
      const currentEmail = localStorage.getItem(STORAGE.email) || "";
      window.Paddle.Initialize({
        token: cachedPaddleConfig.clientToken,
        pwCustomer: currentEmail ? { email: currentEmail } : undefined,
        eventCallback: handlePaddleEvent,
      });
      paddleInitialized = true;
      return true;
    }
    return false;
  } catch (err) {
    console.warn("Paddle initialization notice:", err.message);
    return false;
  }
}

function handlePaddleEvent(data) {
  if (!data || !data.name) return;
  console.log("[Paddle Event]", data.name, data);
  if (data.name === "checkout.completed") {
    toast("🎉 Payment successful! Welcome to Sharflow Pro.");
    localStorage.setItem(STORAGE.plan, "pro");
    const token = localStorage.getItem(STORAGE.token);
    if (token) {
      fetch("/api/user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan: "pro" }),
      }).catch(() => {});
    }
    updateBillingPanelUI();
  }
}

async function openPaddleCheckout(priceIdOverride) {
  const priceId = priceIdOverride || cachedPaddleConfig.defaultPriceId || SHARFLOW_PRO_PRICE_ID;
  const userEmail = localStorage.getItem(STORAGE.email) || "";

  const initialized = await initPaddle();

  if (!initialized || !cachedPaddleConfig.clientToken) {
    console.info("[Paddle Checkout] Client token not configured yet. Checkout remains safely disabled during early access preview.");
    toast("Sharflow Pro online checkout is currently in early-access mode. Contact hello@sharflow.online for early access.");
    return;
  }

  try {
    if (window.Paddle && window.Paddle.Checkout && typeof window.Paddle.Checkout.open === "function") {
      window.Paddle.Checkout.open({
        settings: {
          displayMode: "overlay",
          theme: "light",
          locale: "en",
          successUrl: `${window.location.origin}/?checkout=success`,
        },
        items: [
          {
            priceId: priceId,
            quantity: 1,
          },
        ],
        customer: userEmail ? { email: userEmail } : undefined,
        customData: {
          email: userEmail || undefined,
          plan: "pro",
          source: "sharflow_web",
          priceId: priceId,
        },
      });
    } else {
      toast("Paddle checkout library is not available. Please try again later.");
    }
  } catch (err) {
    console.error("Failed to open Paddle Checkout:", err);
    toast("Paddle Checkout: " + (err.message || "Could not open checkout modal."));
  }
}

function checkoutSharflowPro() {
  openPaddleCheckout(SHARFLOW_PRO_PRICE_ID);
}

function updateBillingPanelUI() {
  const currentPlan = (localStorage.getItem(STORAGE.plan) || "starter").toLowerCase();
  const isPro = currentPlan === "pro" || currentPlan === "sharflow_pro";

  const badge = document.getElementById("dash-plan-badge");
  const title = document.getElementById("current-plan-title");
  const desc = document.getElementById("current-plan-desc");
  const status = document.getElementById("billing-plan-status");
  const actionContainer = document.getElementById("plan-action-container");

  if (badge) {
    badge.textContent = isPro ? "Current Plan: Sharflow Pro" : "Current Plan: Starter";
    badge.className = "badge-pill badge-neutral";
    if (isPro) {
      badge.style.background = "var(--green-soft)";
      badge.style.color = "var(--green)";
      badge.style.borderColor = "#A7F3D0";
    } else {
      badge.style.background = "";
      badge.style.color = "";
      badge.style.borderColor = "";
    }
  }

  if (title) {
    title.textContent = isPro ? "Sharflow Pro Active" : "Sharflow Starter";
  }

  if (desc) {
    desc.textContent = isPro
      ? "Continuous 24/7 Watchdog monitoring, deep GA4 e-commerce tracking, and priority alerts are enabled."
      : "Free early access plan with baseline website checks.";
  }

  if (status) {
    status.textContent = isPro ? "Active Pro Subscriber" : "Active (Free)";
    status.style.color = "var(--green)";
  }

  if (actionContainer) {
    if (isPro) {
      actionContainer.innerHTML = `
        <div style="background:var(--green-soft);border:1px solid #A7F3D0;border-radius:6px;padding:12px;text-align:center;color:var(--green);font-weight:600;font-size:14px;">
          ✓ You are currently subscribed to Sharflow Pro
        </div>
      `;
    } else {
      actionContainer.innerHTML = `
        <button class="btn btn-primary btn-block" id="btn-dashboard-upgrade-pro" onclick="checkoutSharflowPro()">
          Upgrade to Sharflow Pro ($29/mo) →
        </button>
      `;
    }
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────
let googleAuthInitialized = false;
let cachedGoogleClientId = null;

async function initGoogleSignIn() {
  const container = document.getElementById("google-auth-container");
  const btnMount = document.getElementById("google-signin-btn");
  if (!container || !btnMount) return;

  try {
    if (!cachedGoogleClientId) {
      await fetchPaddleConfig();
    }
    if (!cachedGoogleClientId) return;

    // Wait briefly if the async GIS script is still loading
    let attempts = 0;
    while ((!window.google || !window.google.accounts || !window.google.accounts.id) && attempts < 25) {
      await new Promise((r) => setTimeout(r, 120));
      attempts++;
    }
    if (!window.google || !window.google.accounts || !window.google.accounts.id) return;

    if (!googleAuthInitialized) {
      window.google.accounts.id.initialize({
        client_id: cachedGoogleClientId,
        callback: handleGoogleCredentialResponse,
        ux_mode: "popup",
      });
      googleAuthInitialized = true;
    }

    container.classList.remove("hidden");
    btnMount.innerHTML = "";
    window.google.accounts.id.renderButton(btnMount, {
      theme: "outline",
      size: "large",
      shape: "rectangular",
      text: "continue_with",
      width: 320,
    });
  } catch (err) {
    console.warn("Google Sign-In init skipped:", err.message);
  }
}

async function handleGoogleCredentialResponse(response) {
  if (!response || !response.credential) {
    toast("Google sign-in was cancelled or failed.");
    return;
  }

  toast("Signing in with Google…");
  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "google", credential: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "Google sign-in failed.");
      return;
    }

    localStorage.setItem(STORAGE.token, data.token);
    if (data.user?.email) {
      localStorage.setItem(STORAGE.email, data.user.email);
    }
    applyUserToLocalState(data.user);

    closeAuthModal();
    routeAfterAuth(data.user);
  } catch {
    toast("Network error during Google sign-in — please try again.");
  }
}

function openAuthModal(tab = "signup") {
  switchAuthTab(tab);
  document.getElementById("auth-modal").classList.add("open");
  initGoogleSignIn();
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
    localStorage.setItem(STORAGE.userName, name);
    const form = getSavedForm();
    form.name = name;
    localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));
    document.getElementById("pf-name").value = name;
    if (data.user) {
      applyUserToLocalState(data.user);
    }
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

const MONITORING_CATEGORIES = [
  {
    id: "ga4",
    name: "GA4 / Store Performance",
    provider: "google_analytics",
    description: "Shopper conversion, traffic, funnel progression & store revenue",
    options: [
      "Sales & Revenue",
      "Orders / Purchases",
      "Visitors & Traffic",
      "Traffic Sources / Campaigns",
      "Shopping Funnel",
      "Landing Pages",
      "Engagement",
      "Device / Country",
      "Verified AI / Referral Traffic",
    ],
  },
  {
    id: "gsc",
    name: "Google Search Console",
    provider: "google_search_console",
    description: "Organic search visibility, rankings, impressions & indexing",
    options: [
      "Search clicks & impressions",
      "Search queries",
      "Top pages",
      "Search position",
      "Indexing problems",
      "Search traffic changes",
    ],
  },
  {
    id: "bing",
    name: "Bing Webmaster",
    provider: "bing_webmaster",
    description: "Bing & Microsoft Copilot search queries, crawling & indexing",
    options: [
      "Clicks & impressions",
      "Search queries",
      "Top pages",
      "Crawl problems",
      "Indexing problems",
    ],
  },
  {
    id: "technical",
    name: "Website / Technical",
    provider: "technical",
    description: "Availability, priority landing pages & technical alerts",
    options: [
      "Website availability",
      "Important page problems",
      "Technical/indexing alerts",
    ],
  },
];

const ECOMMERCE_DEFAULT_PRIORITIES = [
  "Sales & Revenue",
  "Orders / Purchases",
  "Visitors & Traffic",
  "Traffic Sources / Campaigns",
  "Shopping Funnel",
];

const GENERAL_DEFAULT_PRIORITIES = [
  "Visitors & Traffic",
  "Search clicks & impressions",
  "Search traffic changes",
  "Important page problems",
  "Website availability",
];

const ALL_MONITORING_OPTIONS = MONITORING_CATEGORIES.flatMap((c) => c.options);

const LEGACY_PRIORITY_MAP = {
  "Search visibility": ["Search clicks & impressions", "Search position"],
  "Traffic changes": ["Visitors & Traffic", "Search traffic changes"],
  "Important pages": ["Top pages", "Important page problems", "Landing Pages"],
  "Technical / indexing problems": ["Indexing problems", "Crawl problems", "Technical/indexing alerts"],
  "Leads / conversions": ["Orders / Purchases", "Sales & Revenue", "Shopping Funnel"],
  "Content opportunities": ["Search queries", "Top pages"],
  "Pricing Page Conversions": ["Orders / Purchases", "Shopping Funnel"],
  "Organic Search Rankings": ["Search position", "Search queries"],
};

function normalizeMonitoringPreferences(priorities, websiteType = "") {
  if (!Array.isArray(priorities) || priorities.length === 0) {
    const isEcom = String(websiteType || "").toLowerCase().includes("e-commerce") || String(websiteType || "").toLowerCase().includes("store");
    return isEcom ? [...ECOMMERCE_DEFAULT_PRIORITIES] : [...GENERAL_DEFAULT_PRIORITIES];
  }
  if (priorities.includes("All important changes")) {
    const isEcom = String(websiteType || "").toLowerCase().includes("e-commerce") || String(websiteType || "").toLowerCase().includes("store");
    if (isEcom) {
      return Array.from(new Set([
        ...ECOMMERCE_DEFAULT_PRIORITIES,
        "Landing Pages",
        "Engagement",
        "Verified AI / Referral Traffic",
        "Search clicks & impressions",
        "Search traffic changes",
        "Important page problems",
        "Technical/indexing alerts",
      ]));
    }
    return [...ALL_MONITORING_OPTIONS];
  }

  const set = new Set();
  for (const item of priorities) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (ALL_MONITORING_OPTIONS.includes(trimmed)) {
      set.add(trimmed);
      continue;
    }
    if (LEGACY_PRIORITY_MAP[trimmed]) {
      LEGACY_PRIORITY_MAP[trimmed].forEach((opt) => set.add(opt));
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (lower.includes("revenue") || lower.includes("sales")) set.add("Sales & Revenue");
    if (lower.includes("order") || lower.includes("purchase") || lower.includes("conversion")) set.add("Orders / Purchases");
    if (lower.includes("funnel") || lower.includes("cart") || lower.includes("checkout")) set.add("Shopping Funnel");
    if (lower.includes("visitor") || lower.includes("traffic")) set.add("Visitors & Traffic");
    if (lower.includes("source") || lower.includes("campaign")) set.add("Traffic Sources / Campaigns");
    if (lower.includes("ai") || lower.includes("chatgpt") || lower.includes("referral")) set.add("Verified AI / Referral Traffic");
    if (lower.includes("ranking") || lower.includes("position")) set.add("Search position");
    if (lower.includes("query") || lower.includes("keyword")) set.add("Search queries");
    if (lower.includes("index") || lower.includes("crawl")) set.add("Indexing problems");
    if (lower.includes("page")) set.add("Top pages");
  }

  if (set.size === 0) {
    const isEcom = String(websiteType || "").toLowerCase().includes("e-commerce") || String(websiteType || "").toLowerCase().includes("store");
    return isEcom ? [...ECOMMERCE_DEFAULT_PRIORITIES] : [...GENERAL_DEFAULT_PRIORITIES];
  }

  return Array.from(set);
}

// Flat list alias for backward compatibility
const MONITORING_PRIORITIES = ALL_MONITORING_OPTIONS;

let onboardingData = {
  websiteUrl: "",
  websiteType: "",
  websitePurpose: "",
  monitoringPriorities: [],
  userCustomizedPriorities: false,
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
  const normalizedPriorities = normalizeMonitoringPreferences(saved.monitoringPriorities, saved.websiteType);
  onboardingData = {
    websiteUrl: saved.websiteUrl || "",
    websiteType: saved.websiteType || "",
    websitePurpose: saved.websitePurpose || "",
    monitoringPriorities: [...normalizedPriorities],
    userCustomizedPriorities: Array.isArray(saved.monitoringPriorities) && saved.monitoringPriorities.length > 0,
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

  // Preselect E-commerce categories if user selected E-commerce and hasn't manually customized yet
  if (type === "E-commerce / Online Store") {
    if (!onboardingData.userCustomizedPriorities || onboardingData.monitoringPriorities.length === 0) {
      onboardingData.monitoringPriorities = [...ECOMMERCE_DEFAULT_PRIORITIES];
      renderPriorityOptions();
    }
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

  MONITORING_CATEGORIES.forEach((cat) => {
    const sec = document.createElement("div");
    sec.className = "priority-category-sec";
    sec.style.background = "var(--surface-2)";
    sec.style.border = "1px solid var(--border)";
    sec.style.borderRadius = "var(--radius-sm)";
    sec.style.padding = "14px 16px";

    const allCatSelected = cat.options.every((opt) => onboardingData.monitoringPriorities.includes(opt));

    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.justifyContent = "space-between";
    head.style.alignItems = "center";
    head.style.marginBottom = "10px";
    head.style.flexWrap = "wrap";
    head.style.gap = "8px";

    head.innerHTML = `
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--text);letter-spacing:0.02em;">${escapeHtml(cat.name)}</div>
        <div style="font-size:11.5px;color:var(--muted);">${escapeHtml(cat.description)}</div>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" style="font-size:11px;padding:2px 8px;cursor:pointer;">
        ${allCatSelected ? "Deselect Category" : "Select Category"}
      </button>
    `;

    const toggleBtn = head.querySelector("button");
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      onboardingData.userCustomizedPriorities = true;
      if (allCatSelected) {
        onboardingData.monitoringPriorities = onboardingData.monitoringPriorities.filter((p) => !cat.options.includes(p));
      } else {
        cat.options.forEach((opt) => {
          if (!onboardingData.monitoringPriorities.includes(opt)) {
            onboardingData.monitoringPriorities.push(opt);
          }
        });
      }
      renderPriorityOptions();
      updatePriorityContinueButton();
    };

    const grid = document.createElement("div");
    grid.className = "select-grid";
    grid.style.marginTop = "0";

    cat.options.forEach((priority) => {
      const card = document.createElement("div");
      card.className = "select-card";
      card.setAttribute("data-value", priority);
      const isSelected = onboardingData.monitoringPriorities.includes(priority);
      if (isSelected) card.classList.add("selected");

      card.innerHTML = `
        <span style="font-size:13px;">${escapeHtml(priority)}</span>
        <span class="card-check">✓</span>
      `;
      card.onclick = () => {
        onboardingData.userCustomizedPriorities = true;
        toggleMonitoringPriority(priority);
      };
      grid.appendChild(card);
    });

    sec.appendChild(head);
    sec.appendChild(grid);
    container.appendChild(sec);
  });
}

function toggleMonitoringPriority(priority) {
  onboardingData.userCustomizedPriorities = true;
  const idx = onboardingData.monitoringPriorities.indexOf(priority);
  if (idx >= 0) {
    onboardingData.monitoringPriorities.splice(idx, 1);
  } else {
    onboardingData.monitoringPriorities.push(priority);
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
      onboardingData.monitoringPriorities = normalizeMonitoringPreferences([], onboardingData.websiteType);
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
    btn.textContent = "Saving Watchdog profile…";
  }

  const summaryText = buildWebsiteSummaryText(onboardingData);
  const existingForm = getSavedForm();
  const userFullName = getUserName();

  const form = {
    ...existingForm,
    name: userFullName || existingForm.name || "",
    profileMode: "website-watchdog-onboarding",
    websiteUrl: onboardingData.websiteUrl,
    websiteType: onboardingData.websiteType,
    websitePurpose: onboardingData.websitePurpose,
    monitoringPriorities: onboardingData.monitoringPriorities,
    importantPages: onboardingData.importantPages,
    summary: summaryText,
    profession: existingForm.profession || (onboardingData.websiteType ? `${onboardingData.websiteType} Owner` : "Website Owner"),
    goals: existingForm.goals || onboardingData.websitePurpose || "Monitor website performance",
    topics: existingForm.topics || ((onboardingData.monitoringPriorities || []).join(", ") || "Website performance, SEO, search traffic"),
    avoid: existingForm.avoid !== undefined ? existingForm.avoid : "Broken tracking, vanity metrics without impact",
    customSources: existingForm.customSources || onboardingData.websiteUrl || "",
    language: existingForm.language || "English",
    country: existingForm.country !== undefined ? existingForm.country : "United States",
    newsScope: existingForm.newsScope || "Website Performance",
    digestLength: existingForm.digestLength || "Standard",
    tone: existingForm.tone || "concise",
    digestTime: existingForm.digestTime || "08:00",
    timezone: existingForm.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    lockedUntil: existingForm.lockedUntil || null,
  };

  localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));
  localStorage.setItem(STORAGE.profile, summaryText);

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
          profile: {
            profileMode: "website-watchdog-onboarding",
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
            lockedUntil: form.lockedUntil,
          },
        }),
      });

      // Send welcome email if enabled (without unlock date or trial scheduling)
      fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "welcome",
          email: savedEmail,
          name: form.name,
          profileSummary: summaryText,
        }),
      }).catch((e) => console.warn("Welcome email send error:", e));
    } catch (err) {
      console.warn("Saving profile to DB failed:", err);
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Confirm & Open Dashboard →";
  }

  toast("Your Watchdog profile is ready. Connect your data sources when available to start monitoring.");
  const activeLock = existingForm.lockedUntil ? new Date(existingForm.lockedUntil) : null;
  showDashboard(activeLock, summaryText);
}

function digestLengthToTone(length) {
  if (length === "Quick") return "concise";
  if (length === "Deep") return "detailed";
  return "";
}

function buildProfileSummaryText(form) {
  return [
    `Website: ${form.websiteUrl || "—"}`,
    `Type: ${form.websiteType || "—"}`,
    `Purpose: ${form.websitePurpose || "—"}`,
    `Monitoring: ${Array.isArray(form.monitoringPriorities) ? form.monitoringPriorities.join(", ") : (form.topics || "—")}`,
    form.importantPages ? `Key Pages: ${Array.isArray(form.importantPages) ? form.importantPages.join(", ") : form.importantPages}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function showDashboard(lockDate, profileText, email) {
  document.getElementById("landing-view").classList.add("hidden");
  document.getElementById("app-shell").style.display = "flex";
  document.getElementById("onboarding-view").classList.add("hidden");
  document.getElementById("dashboard-view").classList.remove("hidden");
  document.getElementById("phase-label").textContent = "Dashboard";
  updateBillingPanelUI();

  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const form = getSavedForm();
  const userFullName = getUserName();
  const name = userFullName ? `, ${userFullName.split(" ")[0]}` : (form.name ? `, ${form.name.split(" ")[0]}` : "");
  document.getElementById("dash-greeting").textContent = greet + name;

  // Website details
  const dpWebsite = document.getElementById("dp-website");
  if (dpWebsite) dpWebsite.textContent = form.websiteUrl || form.customSources || "—";
  const dpType = document.getElementById("dp-type");
  if (dpType) dpType.textContent = form.websiteType || form.profession || "—";
  const dpGoal = document.getElementById("dp-goal");
  if (dpGoal) dpGoal.textContent = form.websitePurpose || form.goals || "—";

  // Watchdog status fields
  const dpProfStatus = document.getElementById("dp-profile-status");
  if (dpProfStatus) dpProfStatus.textContent = "Saved ✓";
  const dpCfgStatus = document.getElementById("dp-config-status");
  if (dpCfgStatus) dpCfgStatus.textContent = "Saved ✓";
  const dpIntegrations = document.getElementById("dp-integrations");
  if (dpIntegrations) dpIntegrations.textContent = "Not connected yet";
  const dpStatus = document.getElementById("dp-status");
  if (dpStatus) dpStatus.textContent = "Begins after data sources connect";

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
  loadDataSources();
  if (window.location.hash === "#sources" || window.location.hash === "#datasources") {
    dashNav("sources");
  }
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

const FINDING_CATEGORY_MAP = {
  ecommerce_revenue_drop: ["Sales & Revenue"],
  checkout_to_purchase_drop: ["Orders / Purchases", "Shopping Funnel"],
  add_to_cart_drop: ["Shopping Funnel"],
  conversion_drop: ["Orders / Purchases", "Shopping Funnel"],
  traffic_source_shift: ["Traffic Sources / Campaigns"],
  verified_ai_referral_shift: ["Verified AI / Referral Traffic", "Traffic Sources / Campaigns"],
  landing_page_engagement_drop: ["Landing Pages", "Important page problems"],
  organic_traffic_drop: ["Visitors & Traffic", "Search traffic changes", "Search clicks & impressions"],
  ranking_position_drop: ["Search position", "Search queries"],
  ctr_opportunity: ["Search clicks & impressions", "Search queries"],
  new_page_traction: ["Top pages", "Visitors & Traffic"],
  page_not_indexed: ["Indexing problems", "Important page problems", "Technical/indexing alerts"],
  mobile_usability_issue: ["Technical/indexing alerts", "Important page problems"],
  low_search_visibility_baseline: ["Search clicks & impressions", "Clicks & impressions"],
  bing_organic_click_drop: ["Clicks & impressions", "Search traffic changes"],
  bing_organic_traffic_drop: ["Clicks & impressions", "Search traffic changes"],
  bing_crawl_issues: ["Crawl problems", "Technical/indexing alerts", "Indexing problems"],
};

function matchesUserPreferences(finding, userPreferences) {
  if (!finding) return false;
  if (finding.severity === "critical") return true;
  if (!Array.isArray(userPreferences) || userPreferences.length === 0) return true;
  const mapped = FINDING_CATEGORY_MAP[finding.type] || [];
  return mapped.some((opt) => userPreferences.includes(opt));
}

let editingProfilePriorities = [];

function toggleProfilePreferencesEditor(show) {
  const card = document.getElementById("profile-preferences-card");
  if (!card) return;
  const isHidden = card.classList.contains("hidden");
  const willShow = typeof show === "boolean" ? show : isHidden;

  if (willShow) {
    const form = getSavedForm();
    editingProfilePriorities = normalizeMonitoringPreferences(form.monitoringPriorities, form.websiteType);
    renderProfilePreferencesEditor();
    card.classList.remove("hidden");
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    card.classList.add("hidden");
  }
}

function renderProfilePreferencesEditor() {
  const container = document.getElementById("profile-preferences-container");
  if (!container) return;
  container.innerHTML = "";

  MONITORING_CATEGORIES.forEach((cat) => {
    const sec = document.createElement("div");
    sec.className = "priority-category-sec";
    sec.style.background = "var(--surface-2)";
    sec.style.border = "1px solid var(--border)";
    sec.style.borderRadius = "var(--radius-sm)";
    sec.style.padding = "14px 16px";

    const allCatSelected = cat.options.every((opt) => editingProfilePriorities.includes(opt));

    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.justifyContent = "space-between";
    head.style.alignItems = "center";
    head.style.marginBottom = "10px";
    head.style.flexWrap = "wrap";
    head.style.gap = "8px";

    head.innerHTML = `
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--text);letter-spacing:0.02em;">${escapeHtml(cat.name)}</div>
        <div style="font-size:11.5px;color:var(--muted);">${escapeHtml(cat.description)}</div>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" style="font-size:11px;padding:2px 8px;cursor:pointer;">
        ${allCatSelected ? "Deselect Category" : "Select Category"}
      </button>
    `;

    const toggleBtn = head.querySelector("button");
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      if (allCatSelected) {
        editingProfilePriorities = editingProfilePriorities.filter((p) => !cat.options.includes(p));
      } else {
        cat.options.forEach((opt) => {
          if (!editingProfilePriorities.includes(opt)) {
            editingProfilePriorities.push(opt);
          }
        });
      }
      renderProfilePreferencesEditor();
    };

    const grid = document.createElement("div");
    grid.className = "select-grid";
    grid.style.marginTop = "0";

    cat.options.forEach((priority) => {
      const card = document.createElement("div");
      card.className = "select-card";
      card.setAttribute("data-value", priority);
      const isSelected = editingProfilePriorities.includes(priority);
      if (isSelected) card.classList.add("selected");

      card.innerHTML = `
        <span style="font-size:13px;">${escapeHtml(priority)}</span>
        <span class="card-check">✓</span>
      `;
      card.onclick = () => {
        const idx = editingProfilePriorities.indexOf(priority);
        if (idx >= 0) {
          editingProfilePriorities.splice(idx, 1);
        } else {
          editingProfilePriorities.push(priority);
        }
        renderProfilePreferencesEditor();
      };
      grid.appendChild(card);
    });

    sec.appendChild(head);
    sec.appendChild(grid);
    container.appendChild(sec);
  });
}

async function saveProfilePreferences() {
  if (editingProfilePriorities.length === 0) {
    toast("Please select at least one monitoring category");
    return;
  }

  const btn = document.getElementById("btn-save-preferences");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }

  try {
    const form = getSavedForm();
    form.monitoringPriorities = [...editingProfilePriorities];
    localStorage.setItem(STORAGE.profileForm, JSON.stringify(form));

    const token = localStorage.getItem(STORAGE.token) || "";
    if (token) {
      await fetch("/api/user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: form.name,
          profile: {
            ...form,
            monitoringPriorities: form.monitoringPriorities,
          },
        }),
      });
    }

    // Refresh tags in UI
    const tagsEl = document.getElementById("dp-tags");
    if (tagsEl) {
      tagsEl.innerHTML = "";
      form.monitoringPriorities.slice(0, 10).forEach((t) => {
        const tag = document.createElement("span");
        tag.className = "profile-tag";
        tag.textContent = t;
        tagsEl.appendChild(tag);
      });
    }

    syncProfilePanels();
    toggleProfilePreferencesEditor(false);
    toast("Monitoring preferences updated ✓");
  } catch (err) {
    console.error("Failed to save monitoring preferences:", err);
    toast("Error saving preferences. Saved locally.");
    syncProfilePanels();
    toggleProfilePreferencesEditor(false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save Preferences ✓";
    }
  }
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
  if (!el || !lockDate) return;
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

function renderWatchdogReportHtml(report) {
  if (!report) return "";
  const intel = report.intelligence || {};
  const status = (intel.status || report.status || report.monitoringStatus || "normal").toLowerCase();
  const monitoringStatus = (report.monitoringStatus || "").toLowerCase();
  const isNoSources = status === "no_sources" || monitoringStatus === "no_sources";
  const isInsufficientData = status === "insufficient_data" || monitoringStatus === "insufficient_data";
  const headline = intel.headline || "Website Watchdog Scan Complete";
  const summary = intel.summary || "";
  const findings = Array.isArray(intel.priorityRankedFindings) ? intel.priorityRankedFindings : [];
  const actions = Array.isArray(intel.recommendedActions) ? intel.recommendedActions : [];

  let statusBadgeClass = "green";
  let statusLabel = "All systems normal";
  if (isNoSources) {
    statusBadgeClass = "amber";
    statusLabel = "Monitoring Not Active";
  } else if (isInsufficientData) {
    statusBadgeClass = "amber";
    statusLabel = "Insufficient Data · Baseline Pending";
  } else if (status === "critical" || status === "critical_attention") {
    statusBadgeClass = "red";
    statusLabel = "Critical Attention Needed";
  } else if (status === "warning" || status === "needs_attention") {
    statusBadgeClass = "amber";
    statusLabel = "Needs Attention · Actionable Signals";
  } else if (status === "opportunity") {
    statusBadgeClass = "blue";
    statusLabel = "Growth Opportunity";
  }

  let html = `
    <div class="watchdog-report-view">
      <div class="watchdog-report-header" style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="watchdog-badge watchdog-badge-${statusBadgeClass}">${escapeHtml(statusLabel)}</span>
            ${report.targetDate ? `<span style="font-size:12px;color:var(--dim);">Target date: ${escapeHtml(report.targetDate)}</span>` : ""}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="exportReportCSV()" style="font-size:12px;padding:3px 10px;" title="Download audit findings as formatted CSV">
            Export Report 📥
          </button>
        </div>
        <h2 style="font-size:1.2rem;font-weight:700;color:var(--text);line-height:1.35;margin-bottom:8px;">${escapeHtml(headline)}</h2>
        ${summary ? `<p style="font-size:14px;color:var(--muted);line-height:1.6;margin:0;">${escapeHtml(summary)}</p>` : ""}
      </div>
  `;

  // E-Commerce Store Performance (GA4 Primary)
  const sp = report.storePerformance || null;
  if (sp) {
    const isEcom = sp.configured === true;
    const visitorsVal = `${(sp.sessions || 0).toLocaleString()} sessions`;
    const visitorsSub = sp.users ? `${(sp.users || 0).toLocaleString()} visitors` : "";
    const engageVal = sp.engagementRate !== null && sp.engagementRate !== undefined
      ? `${(sp.engagementRate * 100).toFixed(1)}%`
      : (sp.averageEngagementTime ? `${sp.averageEngagementTime}s avg` : "—");
    const cartVal = isEcom && sp.addToCartCount !== null ? (sp.addToCartCount || 0).toLocaleString() : "Not configured";
    const checkoutVal = isEcom && sp.checkoutCount !== null ? (sp.checkoutCount || 0).toLocaleString() : "Not configured";
    const purchasesVal = isEcom && sp.purchaseCount !== null ? (sp.purchaseCount || 0).toLocaleString() : "Not configured";
    const revenueVal = isEcom && sp.revenue !== null ? `$${sp.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Not configured";

    let dropOffContent = "";
    if (isEcom && sp.checkoutCount > 0 && sp.purchaseCount !== null) {
      const c2pRate = sp.checkoutToPurchaseRate !== null ? sp.checkoutToPurchaseRate : ((sp.purchaseCount / sp.checkoutCount) * 100);
      const abandonRate = Math.max(0, 100 - c2pRate).toFixed(1);
      if (sp.addToCartCount > 0 && sp.checkoutCount < sp.addToCartCount) {
        const cartToCheckout = ((sp.checkoutCount / sp.addToCartCount) * 100).toFixed(1);
        dropOffContent = `
          <div style="font-size:13px;color:var(--text);line-height:1.5;">
            <strong>Checkout Drop-Off:</strong> ${abandonRate}% of shoppers who began checkout did not complete their order (${sp.checkoutCount} checkouts vs ${sp.purchaseCount} orders).<br/>
            <span style="color:var(--muted);">Cart-to-checkout progression: ${cartToCheckout}% of cart additions proceeded to checkout.</span>
          </div>
        `;
      } else {
        dropOffContent = `
          <div style="font-size:13px;color:var(--text);line-height:1.5;">
            <strong>Checkout Conversion:</strong> ${c2pRate.toFixed(1)}% of shoppers who started checkout completed their purchase (${abandonRate}% checkout drop-off).
          </div>
        `;
      }
    } else if (isEcom) {
      dropOffContent = `
        <div style="font-size:13px;color:var(--muted);line-height:1.5;">
          Shopper funnel progression steady with ${(sp.sessions || 0).toLocaleString()} visits recorded yesterday.
        </div>
      `;
    } else {
      dropOffContent = `
        <div style="font-size:13px;color:var(--muted);line-height:1.5;">
          E-commerce funnel events (<code style="font-size:12px;">add_to_cart</code>, <code style="font-size:12px;">begin_checkout</code>, <code style="font-size:12px;">purchase</code>) are not yet configured in your GA4 property. Once enabled, drop-off analysis will populate automatically.
        </div>
      `;
    }

    const topChannels = Array.isArray(sp.topChannels) ? sp.topChannels : [];
    const aiReferrals = Array.isArray(sp.aiReferrals) ? sp.aiReferrals : [];
    const totalSess = sp.sessions || 1;

    let sourcesContent = "";
    if (topChannels.length > 0) {
      const channelPills = topChannels.map((c) => {
        const pct = Math.round((c.sessions / totalSess) * 100);
        return `<span style="display:inline-block;padding:3px 8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);margin-right:6px;margin-bottom:4px;"><strong>${escapeHtml(c.channel)}:</strong> ${c.sessions} (${pct}%)</span>`;
      }).join("");

      let aiPills = "";
      if (aiReferrals.length > 0) {
        const aiItems = aiReferrals.map((a) => `${a.sessions} session${a.sessions > 1 ? "s" : ""} attributed to ${escapeHtml(a.platform || a.source)}`).join(", ");
        aiPills = `<div style="margin-top:6px;font-size:12px;color:var(--accent);">🤖 <strong>Verified AI Referrals:</strong> ${aiItems}</div>`;
      }

      sourcesContent = `
        <div style="margin-bottom:4px;">${channelPills}</div>
        ${aiPills}
      `;
    } else {
      sourcesContent = `<div style="font-size:12px;color:var(--muted);">No traffic sources recorded yesterday.</div>`;
    }

    html += `
      <div class="watchdog-store-section" style="margin-bottom:18px;">
        <h4 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:10px;">Yesterday's Store Performance</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:10px;margin-bottom:12px;">
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Visitors</div>
            <div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(visitorsVal)}</div>
            ${visitorsSub ? `<div style="font-size:11px;color:var(--dim);margin-top:2px;">${escapeHtml(visitorsSub)}</div>` : ""}
          </div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Engagement</div>
            <div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(engageVal)}</div>
            <div style="font-size:11px;color:var(--dim);margin-top:2px;">Session quality</div>
          </div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Add to Cart</div>
            <div style="font-size:15px;font-weight:700;color:${isEcom && sp.addToCartCount !== null ? "var(--text)" : "var(--dim)"};">${escapeHtml(cartVal)}</div>
            <div style="font-size:11px;color:var(--dim);margin-top:2px;">${isEcom && sp.addToCartRate !== null ? `${sp.addToCartRate}% of visits` : "Cart events"}</div>
          </div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Checkouts</div>
            <div style="font-size:15px;font-weight:700;color:${isEcom && sp.checkoutCount !== null ? "var(--text)" : "var(--dim)"};">${escapeHtml(checkoutVal)}</div>
            <div style="font-size:11px;color:var(--dim);margin-top:2px;">${isEcom && sp.checkoutRate !== null ? `${sp.checkoutRate}% of visits` : "Checkouts started"}</div>
          </div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Purchases</div>
            <div style="font-size:15px;font-weight:700;color:${isEcom && sp.purchaseCount !== null ? "var(--text)" : "var(--dim)"};">${escapeHtml(purchasesVal)}</div>
            <div style="font-size:11px;color:var(--dim);margin-top:2px;">${isEcom && sp.purchaseConversionRate !== null ? `${sp.purchaseConversionRate}% conv. rate` : "Completed orders"}</div>
          </div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Revenue</div>
            <div style="font-size:15px;font-weight:700;color:${isEcom && sp.revenue !== null ? "#059669" : "var(--dim)"};">${escapeHtml(revenueVal)}</div>
            <div style="font-size:11px;color:var(--dim);margin-top:2px;">Total sales</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));gap:10px;">
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;">
            <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Where Shoppers Dropped Off</div>
            ${dropOffContent}
          </div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;">
            <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Traffic Sources &amp; Attribution</div>
            ${sourcesContent}
          </div>
        </div>
      </div>
    `;
  }

  // 1. Priority-Ranked Findings (prioritizing user-selected monitoring categories)
  const userPreferences = report.userPreferences || getSavedForm().monitoringPriorities || [];
  const displayFindings = [...findings].sort((a, b) => {
    if (a.severity === "critical" && b.severity !== "critical") return -1;
    if (b.severity === "critical" && a.severity !== "critical") return 1;
    if (userPreferences.length > 0) {
      const aMatch = matchesUserPreferences(a, userPreferences);
      const bMatch = matchesUserPreferences(b, userPreferences);
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
    }
    return (a.priorityRank || 99) - (b.priorityRank || 99);
  });

  if (displayFindings.length > 0) {
    html += `
      <div class="watchdog-findings-section" style="margin-bottom:18px;">
        <h4 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:10px;">Needs Attention · Actionable Signals (${displayFindings.length})</h4>
        <div style="display:flex;flex-direction:column;gap:12px;">
    `;

    displayFindings.forEach((f, idx) => {
      const rank = f.priorityRank || (idx + 1);
      const badgeText = f.priorityBadge || `P${rank}`;
      const title = f.title || f.type || "Observation";
      const primaryCause = f.primaryCause || "";
      const plausibleCauses = Array.isArray(f.plausibleCauses) ? f.plausibleCauses : [];
      const impact = f.impactAssessment || "";
      const evContext = f.originalEvidence?.context || f.evidence?.context || "";
      const itemActions = Array.isArray(f.recommendedActions) ? f.recommendedActions : [];
      const isPreferred = matchesUserPreferences(f, userPreferences);

      let badgeBg = "var(--surface-2)";
      let badgeColor = "var(--muted)";
      if (f.severity === "critical" || badgeText.includes("P1") || badgeText.includes("Immediate")) {
        badgeBg = "#FEE2E2";
        badgeColor = "#DC2626";
      } else if (f.severity === "warning" || badgeText.includes("P2") || badgeText.includes("High")) {
        badgeBg = "#FEF3C7";
        badgeColor = "#D97706";
      } else if (f.severity === "opportunity" || badgeText.includes("Opportunity")) {
        badgeBg = "#EFF6FF";
        badgeColor = "#2563EB";
      }

      html += `
        <div class="watchdog-finding-card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:100px;background:${badgeBg};color:${badgeColor};">${escapeHtml(badgeText)}</span>
            <strong style="font-size:14px;color:var(--text);">${escapeHtml(title)}</strong>
            ${isPreferred ? `<span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;background:var(--accent-soft);color:var(--accent);margin-left:auto;">★ Monitored</span>` : ""}
          </div>
          ${evContext ? `<div style="font-size:13px;color:var(--text);margin-bottom:8px;background:var(--surface);padding:8px 12px;border-radius:6px;border:1px solid var(--border);">${escapeHtml(evContext)}</div>` : ""}
          ${primaryCause ? `<p style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:6px;"><strong>Possible explanation (hypothesis):</strong> ${escapeHtml(primaryCause)}</p>` : ""}
          ${plausibleCauses.length > 1 ? `
            <details style="font-size:12px;color:var(--dim);margin-bottom:8px;cursor:pointer;">
              <summary style="font-weight:600;color:var(--muted);margin-bottom:4px;">Alternative hypotheses (${plausibleCauses.length})</summary>
              <ul style="padding-left:18px;margin:4px 0;">
                ${plausibleCauses.map((c) => `<li style="margin-bottom:2px;">${escapeHtml(c)}</li>`).join("")}
              </ul>
            </details>
          ` : ""}
          ${impact ? `<p style="font-size:12px;color:var(--muted);margin-bottom:8px;"><strong>Impact:</strong> ${escapeHtml(impact)}</p>` : ""}
          ${itemActions.length > 0 ? `
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
              <span style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--dim);letter-spacing:0.05em;">Recommended resolution:</span>
              <ul style="margin:4px 0 0 0;padding-left:18px;font-size:13px;color:var(--text);line-height:1.45;">
                ${itemActions.map((a) => {
                  if (typeof a === "string") return `<li>${escapeHtml(a)}</li>`;
                  const urg = a.urgency ? `<span style="font-size:10px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:4px;background:#F1F5F9;color:var(--muted);margin-right:4px;">${escapeHtml(a.urgency)}</span>` : "";
                  return `<li style="margin-bottom:4px;">${urg}<strong>${escapeHtml(a.action || "")}</strong>${a.detail ? `<div style="font-size:12px;color:var(--muted);margin-top:2px;">${escapeHtml(a.detail)}</div>` : ""}</li>`;
                }).join("")}
              </ul>
            </div>
          ` : ""}
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  } else if (isNoSources) {
    html += `
      <div style="background:var(--amber-soft);border:1px solid var(--amber-border);border-radius:var(--radius-sm);padding:14px 16px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <strong style="color:var(--amber-text);font-size:14px;">No connected data sources</strong>
        </div>
        <p style="margin:0;font-size:13px;color:var(--text);line-height:1.5;">Watchdog cannot evaluate website health or detect issues without at least one connected data source. Connect Google Search Console, Google Analytics 4, or Bing Webmaster Tools to begin monitoring.</p>
      </div>
    `;
  } else if (isInsufficientData) {
    html += `
      <div style="background:var(--amber-soft);border:1px solid var(--amber-border);border-radius:var(--radius-sm);padding:14px 16px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <strong style="color:var(--amber-text);font-size:14px;">Insufficient monitoring baseline</strong>
        </div>
        <p style="margin:0;font-size:13px;color:var(--text);line-height:1.5;">Not enough usable comparison data is available yet. Watchdog requires at least 2 consecutive daily snapshots to evaluate trend baselines and confirm normal website health.</p>
      </div>
    `;
  } else {
    // Normal / all clear state
    html += `
      <div style="background:var(--green-soft);border:1px solid #A7F3D0;border-radius:var(--radius-sm);padding:14px 16px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="color:var(--green);font-size:16px;">✓</span>
          <strong style="color:var(--green);font-size:14px;">No critical anomalies detected</strong>
        </div>
        <p style="margin:0;font-size:13px;color:var(--text);line-height:1.5;">All traffic sources, query positions, and conversion milestones are tracking within baseline noise boundaries.</p>
      </div>
    `;
  }

  // 2. Recommended Actions
  if (actions.length > 0) {
    html += `
      <div class="watchdog-actions-section" style="margin-bottom:12px;">
        <h4 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:8px;">Recommended Actions</h4>
        <ol style="margin:0;padding-left:20px;font-size:13px;color:var(--text);line-height:1.6;">
    `;
    actions.forEach((act) => {
      if (typeof act === "string") {
        html += `<li style="margin-bottom:6px;">${escapeHtml(act)}</li>`;
      } else if (typeof act === "object" && act.action) {
        html += `<li style="margin-bottom:6px;"><strong>${escapeHtml(act.action)}</strong>${act.detail ? ` — <span style="color:var(--muted);">${escapeHtml(act.detail)}</span>` : ""}</li>`;
      }
    });
    html += `
        </ol>
      </div>
    `;
  }

  html += `</div>`;
  return html;
}

function renderWatchdogReport(report) {
  const el = document.getElementById("digest-output");
  const note = document.getElementById("digest-source-note");
  if (!el || !report) return;

  el.className = "digest-content";
  el.innerHTML = renderWatchdogReportHtml(report);

  if (note) {
    const aiSkipped = report.intelligence?.aiCallSkipped;
    const model = report.intelligence?.modelUsed || "Watchdog Heuristics";
    const findingsCount = report.findingsCount ?? (report.findings?.length || 0);
    const status = (report.intelligence?.status || report.status || report.monitoringStatus || "").toLowerCase();
    const monitoringStatus = (report.monitoringStatus || "").toLowerCase();
    if (status === "no_sources" || monitoringStatus === "no_sources") {
      note.textContent = `Monitoring inactive · Connect data sources · ${report.targetDate || "Today"}`;
    } else if (status === "insufficient_data" || monitoringStatus === "insufficient_data") {
      note.textContent = `Awaiting comparison baselines · Sync in progress · ${report.targetDate || "Today"}`;
    } else if (aiSkipped) {
      note.textContent = `Scanned active sources · Zero anomalies detected · ${report.targetDate || "Today"}`;
    } else {
      note.textContent = `${findingsCount} findings analyzed with ${model} · ${report.targetDate || "Today"}`;
    }
  }

  // Set report reference and plain-text summary for email
  window._lastWatchdogReport = report;
  const intel = report.intelligence || {};
  const actionsList = (intel.recommendedActions || []).map((a) => `- ${typeof a === 'string' ? a : a.action}`).join('\n');
  window._lastDigestContent = `${intel.headline || "Website Watchdog Report"}\n\n${intel.summary || ""}\n\nRecommended Actions:\n${actionsList}`;

  syncDigestPanels();
}

function renderCachedDigest() {
  const el = document.getElementById("digest-output");
  const note = document.getElementById("digest-source-note");
  if (!el) return;

  const rawSavedReport = localStorage.getItem(STORAGE.lastWatchdogReport);
  let savedReport = null;
  if (rawSavedReport) {
    try {
      savedReport = JSON.parse(rawSavedReport);
    } catch {}
  }

  if (savedReport && savedReport.intelligence) {
    renderWatchdogReport(savedReport);
    return;
  }

  const legacyContent = localStorage.getItem(STORAGE.lastDigest);
  const date = localStorage.getItem(STORAGE.lastDigestDate);
  if (legacyContent && typeof legacyContent === "string" && !legacyContent.startsWith("{")) {
    el.className = "digest-content";
    setDigestContent(el, legacyContent);
    if (note) note.textContent = date ? `Cached from ${date}` : "Cached";
    syncDigestPanels();
    return;
  }

  el.className = "digest-content empty";
  el.innerHTML = `
    <div style="padding:14px 4px;">
      <p style="margin:0 0 6px;font-weight:600;color:var(--text);font-size:14px;">No monitoring reports yet</p>
      <p style="margin:0 0 14px;color:var(--muted);font-size:13px;line-height:1.5;">Your website profile and monitoring configuration are saved. Click below to run your real-time website audit.</p>
      <button class="btn btn-primary btn-sm" id="btn-generate-digest" onclick="generateDashboardDigest(false)">Check my website now ↻</button>
    </div>
  `;
  if (note) note.textContent = "";
  syncDigestPanels();

  fetchLatestReportIfAvailable();
}

async function fetchLatestReportIfAvailable() {
  try {
    const headers = authHeaders();
    if (!headers.Authorization) return;
    const res = await fetch("/api/watchdog?viewLatest=true", {
      headers,
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.report && data.report.intelligence) {
      renderWatchdogReport(data.report);
      localStorage.setItem(STORAGE.lastWatchdogReport, JSON.stringify(data.report));
    }
  } catch {}
}

async function generateDashboardDigest(auto = false) {
  const el = document.getElementById("digest-output");
  const note = document.getElementById("digest-source-note");
  const btn = document.getElementById("btn-generate-digest");
  const btnCheck = document.getElementById("btn-check-website");
  const btnFull = document.getElementById("btn-generate-digest-full");

  el.className = "digest-status";
  el.innerHTML = `<div class="spinner"></div><span>Checking website performance and analyzing metrics…</span>`;
  if (btn) btn.disabled = true;
  if (btnCheck) btnCheck.disabled = true;
  if (btnFull) btnFull.disabled = true;

  try {
    const res = await fetch("/api/watchdog", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ action: "run" }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.report) {
      const errorMsg = data?.error || (typeof data === "string" ? data : "");
      throw new Error(errorMsg || "Failed to generate report");
    }

    const report = data.report;
    renderWatchdogReport(report);
    localStorage.setItem(STORAGE.lastWatchdogReport, JSON.stringify(report));
    localStorage.setItem(STORAGE.lastDigestDate, new Date().toISOString().split("T")[0]);
    if (!auto) toast("Watchdog check complete · Intelligence updated");
  } catch (e) {
    console.error("Watchdog check error:", e);
    const friendlyMsg = "We couldn't complete your check just now — please try again in a moment.";
    el.className = "digest-content empty";
    el.innerHTML = `
      <div style="padding:16px 4px;">
        <p style="margin:0 0 6px;font-weight:600;color:var(--text);font-size:14px;">Notice</p>
        <p style="margin:0 0 14px;color:var(--muted);font-size:13px;line-height:1.5;">${friendlyMsg}</p>
        <button class="btn btn-secondary btn-sm" id="btn-generate-digest" onclick="generateDashboardDigest(false)">Check my website now ↻</button>
      </div>
    `;
    if (note) note.textContent = "";
    syncDigestPanels();
    toast(friendlyMsg);
  } finally {
    if (btn) btn.disabled = false;
    if (btnCheck) btnCheck.disabled = false;
    if (btnFull) btnFull.disabled = false;
  }
}

async function sendDigestEmail() {
  const savedEmail = localStorage.getItem(STORAGE.email) || "";
  const form = getSavedForm();
  const rawSavedReport = localStorage.getItem(STORAGE.lastWatchdogReport);
  let report = window._lastWatchdogReport || null;
  if (!report && rawSavedReport) {
    try { report = JSON.parse(rawSavedReport); } catch {}
  }

  if (!savedEmail) {
    toast("Sign in with email first.");
    return;
  }
  if (!report) {
    toast("Run a Watchdog website check first.");
    return;
  }
  toast("Sending Watchdog report to " + savedEmail + "…");
  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "watchdog_report",
        email: savedEmail,
        name: form.name || "",
        report,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Send failed");
    toast("Watchdog report emailed to " + savedEmail);
  } catch (e) {
    toast("Email failed: " + e.message);
  }
}

function exportReportCSV() {
  const rawSavedReport = localStorage.getItem(STORAGE.lastWatchdogReport);
  let report = window._lastWatchdogReport || null;
  if (!report && rawSavedReport) {
    try {
      report = JSON.parse(rawSavedReport);
    } catch {}
  }

  if (!report) {
    toast("No audit report available to export. Run 'Check my website now' first.");
    return;
  }

  const intel = report.intelligence || {};
  const status = (intel.status || report.status || report.monitoringStatus || "normal").toLowerCase();
  const monitoringStatus = (report.monitoringStatus || "").toLowerCase();
  const isNoSources = status === "no_sources" || monitoringStatus === "no_sources";
  const isInsufficientData = status === "insufficient_data" || monitoringStatus === "insufficient_data";

  const form = typeof getSavedForm === "function" ? getSavedForm() : {};
  const websiteDomain = report.websiteUrl || form.websiteUrl || "your-website.com";
  const reportDate = report.targetDate || new Date().toISOString().split("T")[0];

  // Helper for CSV escaping (RFC 4180 + Excel DDE / formula injection protection)
  function csvCell(val) {
    if (val == null) return '""';
    let str = String(val).trim();
    // Neutralize spreadsheet formula injection (=, +, -, @)
    if (/^[=+\-@]/.test(str)) {
      str = "'" + str;
    }
    return `"${str.replace(/"/g, '""')}"`;
  }

  const headers = [
    "Report Date",
    "Website",
    "Priority",
    "Severity",
    "Finding Title",
    "Category",
    "Affected Scope",
    "Evidence Context",
    "Metric Shift",
    "Probable Root Cause",
    "Impact Assessment",
    "Recommended Actions"
  ];

  const rows = [];
  const findings = Array.isArray(intel.priorityRankedFindings) && intel.priorityRankedFindings.length > 0
    ? intel.priorityRankedFindings
    : (Array.isArray(report.findings) ? report.findings : []);

  const overallActions = Array.isArray(intel.recommendedActions) ? intel.recommendedActions : [];

  if (findings.length > 0) {
    findings.forEach((f, idx) => {
      const rank = f.priorityRank || (idx + 1);
      const priority = f.priorityBadge || `P${rank}`;
      const severity = (f.severity || (priority.includes("P1") ? "critical" : "warning")).toUpperCase();
      const title = f.title || f.evidence?.context || f.originalEvidence?.context || f.type || `Finding #${rank}`;
      const category = f.type || "Performance Metric";
      const scope = f.scope || f.originalEvidence?.scope || f.evidence?.scope || "Site-wide";

      let evidenceText = "";
      if (f.originalEvidence?.context) {
        evidenceText = f.originalEvidence.context;
      } else if (f.evidence?.context) {
        evidenceText = f.evidence.context;
      } else if (f.originalEvidence?.metric) {
        evidenceText = `${f.originalEvidence.metric}: ${f.originalEvidence.deltaPercent != null ? f.originalEvidence.deltaPercent + '%' : ''}`;
      } else if (f.evidence?.metric) {
        evidenceText = `${f.evidence.metric}: ${f.evidence.deltaPercent != null ? f.evidence.deltaPercent + '%' : ''}`;
      } else {
        evidenceText = "Identified via baseline comparison";
      }

      let deltaText = "";
      if (f.originalEvidence?.deltaPercent != null) {
        deltaText = `${f.originalEvidence.deltaPercent}%`;
      } else if (f.evidence?.deltaPercent != null) {
        deltaText = `${f.evidence.deltaPercent}%`;
      }

      const rootCause = f.primaryCause || (Array.isArray(f.plausibleCauses) && f.plausibleCauses.length > 0 ? f.plausibleCauses[0] : "Requires manual audit");
      const impact = f.impactAssessment || `Impacts ${scope}`;

      let actionsText = "";
      if (Array.isArray(f.recommendedActions) && f.recommendedActions.length > 0) {
        actionsText = f.recommendedActions.map((a) => {
          if (typeof a === "string") return a;
          const urg = a.urgency ? `[${a.urgency.toUpperCase()}] ` : "";
          const act = a.action || "";
          const det = a.detail ? ` (${a.detail})` : "";
          return `${urg}${act}${det}`;
        }).join(" | ");
      } else if (overallActions.length > 0) {
        actionsText = overallActions.map((a) => typeof a === "string" ? a : a.action).join(" | ");
      }

      rows.push([
        reportDate,
        websiteDomain,
        priority,
        severity,
        title,
        category,
        scope,
        evidenceText,
        deltaText,
        rootCause,
        impact,
        actionsText
      ]);
    });
  } else {
    let statusPriority = "P0";
    let statusSeverity = "NORMAL";
    let statusTitle = intel.headline || "Website Watchdog Scan Complete";
    let statusCategory = "Health Check";
    let statusEvidence = intel.summary || "All metrics tracking within baseline bounds. No significant ranking or traffic anomalies detected.";
    let statusCause = "None - systems operating normally";
    let statusImpact = "No negative business impact detected";
    let statusActions = overallActions.map((a) => typeof a === "string" ? a : a.action).join(" | ") || "Continue automated monitoring";

    if (isNoSources) {
      statusPriority = "CONFIG";
      statusSeverity = "INFO";
      statusTitle = "No connected data sources";
      statusCategory = "Configuration";
      statusEvidence = "Watchdog requires Google Search Console, GA4, or Bing Webmaster Tools to evaluate website health.";
      statusCause = "Data sources not yet linked";
      statusImpact = "Active anomaly detection paused until data sources are connected";
      statusActions = "Connect data sources in Data Sources tab";
    } else if (isInsufficientData) {
      statusPriority = "BASELINE";
      statusSeverity = "PENDING";
      statusTitle = "Insufficient monitoring baseline";
      statusCategory = "Baseline Accumulation";
      statusEvidence = "Requires at least 2 consecutive daily snapshots to evaluate trend baselines and confirm normal website health.";
      statusCause = "Initial snapshot baseline in progress";
      statusImpact = "Historical comparison baselines pending";
      statusActions = "Awaiting subsequent daily scan snapshots";
    }

    rows.push([
      reportDate,
      websiteDomain,
      statusPriority,
      statusSeverity,
      statusTitle,
      statusCategory,
      "Site-wide",
      statusEvidence,
      "0%",
      statusCause,
      statusImpact,
      statusActions
    ]);
  }

  // Prepend UTF-8 BOM so Excel & Sheets cleanly recognize special characters
  const csvLines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(","))
  ];
  const csvContent = "\uFEFF" + csvLines.join("\r\n");

  const safeDomain = (websiteDomain || "website")
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .replace(/\./g, "-")
    .slice(0, 32);
  const safeDate = String(reportDate).replace(/[^0-9-]/g, "");
  const filename = `sharflow-audit-${safeDomain}-${safeDate}.csv`;

  try {
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast("Audit report exported as CSV 📥");
  } catch (err) {
    console.error("Failed to download CSV:", err);
    toast("Error exporting CSV report.");
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
  if (panel === "sources") {
    loadDataSources();
  }
  if (panel === "billing") {
    updateBillingPanelUI();
  }
  try {
    if (panel === "overview") {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } else {
      history.replaceState(null, "", `#${panel}`);
    }
  } catch {}
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
  // Check if returning from a successful Paddle checkout
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("checkout") === "success") {
      toast("🎉 Payment successful! Welcome to Sharflow Pro.");
      localStorage.setItem(STORAGE.plan, "pro");
      const token = localStorage.getItem(STORAGE.token);
      if (token) {
        fetch("/api/user", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ plan: "pro" }),
        }).catch(() => {});
      }
      urlParams.delete("checkout");
      const newQuery = urlParams.toString();
      const newUrl = window.location.pathname + (newQuery ? `?${newQuery}` : "") + window.location.hash;
      window.history.replaceState(null, "", newUrl);
    }
  } catch {}

  // Initialize Paddle client in background
  initPaddle();

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

// ── Data Sources Connection & Property Management ────────────────────────────
let cachedDataSources = null;

async function loadDataSources() {
  const token = localStorage.getItem(STORAGE.token);
  if (!token) return;

  try {
    const res = await fetch("/api/datasources", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.sources) return;

    cachedDataSources = data.sources;
    renderDataSourceCard("google_search_console", data.sources.google_search_console, "gsc");
    renderDataSourceCard("google_analytics", data.sources.google_analytics, "ga4");
    renderDataSourceCard("bing_webmaster", data.sources.bing_webmaster, "bing");

    updateOverviewSourcesSummary(data.sources);
  } catch (err) {
    console.warn("[DataSources] Failed to fetch sources status:", err.message);
  }
}

function renderDataSourceCard(provider, info, prefix) {
  const badge = document.getElementById(`${prefix}-status-badge`);
  const connInfo = document.getElementById(`${prefix}-connected-info`);
  const propLabel = document.getElementById(`${prefix}-property-label`);
  const lastSync = document.getElementById(`${prefix}-last-sync`);
  const accRow = document.getElementById(`${prefix}-account-row`);
  const accEmail = document.getElementById(`${prefix}-account-email`);

  const btnConnect = document.getElementById(`btn-connect-${prefix}`);
  const btnChange = document.getElementById(`btn-change-${prefix}`);
  const btnDisconnect = document.getElementById(`btn-disconnect-${prefix}`);
  const banner = document.getElementById(`${prefix}-status-banner`);

  // Provider-specific rendering for GA4 with three verified states
  if (provider === "google_analytics" && info) {
    const state = info.statusState || (info.connected ? "connected" : "not_connected");

    if (state === "connected") {
      if (badge) {
        badge.textContent = info.statusBadge || "Connected ✓";
        badge.style.background = "var(--green-soft)";
        badge.style.color = "var(--green)";
        badge.style.borderColor = "#A7F3D0";
      }
      if (banner) {
        banner.style.display = "block";
        banner.style.background = "#F0FDF4";
        banner.style.border = "1px solid #BBF7D0";
        banner.style.color = "#166534";
        banner.textContent = info.statusMessage || "Connected & verified · Traffic monitoring active.";
      }
      if (connInfo) connInfo.style.display = "block";
      if (btnConnect) btnConnect.style.display = "none";
      if (btnChange) {
        btnChange.textContent = "Change Property";
        btnChange.style.display = "inline-block";
      }
      if (btnDisconnect) btnDisconnect.style.display = "inline-block";
    } else if (state === "partially_configured") {
      if (badge) {
        badge.textContent = info.statusBadge || "Partially configured";
        badge.style.background = "#FEF3C7";
        badge.style.color = "#92400E";
        badge.style.borderColor = "#FDE68A";
      }
      if (banner) {
        banner.style.display = "block";
        banner.style.background = "#FFFBEB";
        banner.style.border = "1px solid #FDE68A";
        banner.style.color = "#92400E";
        banner.innerHTML = `<strong>Partially configured:</strong> ${escapeHtml(info.statusMessage || "")}`;
      }
      if (connInfo) connInfo.style.display = "block";
      if (btnConnect) btnConnect.style.display = "none";
      if (btnChange) {
        btnChange.textContent = "Change Property";
        btnChange.style.display = "inline-block";
      }
      if (btnDisconnect) btnDisconnect.style.display = "inline-block";
    } else if (state === "action_required") {
      if (badge) {
        badge.textContent = info.statusBadge || "Action required ⚠️";
        badge.style.background = "#FEF2F2";
        badge.style.color = "#DC2626";
        badge.style.borderColor = "#FECACA";
      }
      if (banner) {
        banner.style.display = "block";
        banner.style.background = "#FEF2F2";
        banner.style.border = "1px solid #FECACA";
        banner.style.color = "#991B1B";
        banner.innerHTML = `<strong>Action required:</strong> ${escapeHtml(info.statusMessage || "A problem prevents monitoring.")}`;
      }
      if (connInfo) {
        connInfo.style.display = info.selectedProperty && info.selectedProperty.name ? "block" : "none";
      }
      if (info.actionType === "reconnect") {
        if (btnConnect) {
          btnConnect.textContent = info.actionLabel || "Reconnect Google Analytics →";
          btnConnect.style.display = "inline-block";
        }
        if (btnChange) btnChange.style.display = "none";
        if (btnDisconnect) btnDisconnect.style.display = "inline-block";
      } else if (info.actionType === "select_property") {
        if (btnConnect) btnConnect.style.display = "none";
        if (btnChange) {
          btnChange.textContent = info.actionLabel || "Select Property →";
          btnChange.style.display = "inline-block";
        }
        if (btnDisconnect) btnDisconnect.style.display = "inline-block";
      } else {
        if (btnConnect) btnConnect.style.display = "none";
        if (btnChange) {
          btnChange.textContent = info.actionLabel || "Change Property";
          btnChange.style.display = "inline-block";
        }
        if (btnDisconnect) btnDisconnect.style.display = "inline-block";
      }
    } else {
      // not_connected
      if (badge) {
        badge.textContent = "Not connected";
        badge.style.background = "#FEF3C7";
        badge.style.color = "#92400E";
        badge.style.borderColor = "#FDE68A";
      }
      if (banner) banner.style.display = "none";
      if (connInfo) connInfo.style.display = "none";
      if (btnConnect) {
        btnConnect.textContent = "Connect Analytics →";
        btnConnect.style.display = "inline-block";
      }
      if (btnChange) btnChange.style.display = "none";
      if (btnDisconnect) btnDisconnect.style.display = "none";
    }

    if (propLabel) {
      if (info.selectedProperty && info.selectedProperty.name) {
        propLabel.textContent = info.selectedProperty.name;
        propLabel.style.color = "var(--text)";
      } else {
        propLabel.textContent = "No property selected yet — click below to select";
        propLabel.style.color = "#D97706";
      }
    }
    if (lastSync) {
      lastSync.textContent = info.lastSuccessfulSync
        ? new Date(info.lastSuccessfulSync).toLocaleString()
        : "Ready to sync";
    }
    if (accRow && accEmail && info.accountEmail) {
      accEmail.textContent = info.accountEmail;
      accRow.style.display = "block";
    }
    return;
  }

  // Standard fallback for other data sources (GSC, Bing)
  if (banner) banner.style.display = "none";
  if (info && info.connected) {
    if (badge) {
      badge.textContent = "Connected ✓";
      badge.style.background = "var(--green-soft)";
      badge.style.color = "var(--green)";
      badge.style.borderColor = "#A7F3D0";
    }
    if (connInfo) connInfo.style.display = "block";
    if (propLabel) {
      if (info.selectedProperty && info.selectedProperty.name) {
        propLabel.textContent = info.selectedProperty.name;
        propLabel.style.color = "var(--text)";
      } else {
        propLabel.textContent = "No property selected yet — click below to select";
        propLabel.style.color = "#D97706";
      }
    }
    if (lastSync) {
      lastSync.textContent = info.lastSuccessfulSync
        ? new Date(info.lastSuccessfulSync).toLocaleString()
        : "Ready to sync";
    }
    if (accRow && accEmail && info.accountEmail) {
      accEmail.textContent = info.accountEmail;
      accRow.style.display = "block";
    }

    if (btnConnect) btnConnect.style.display = "none";
    if (btnChange) btnChange.style.display = "inline-block";
    if (btnDisconnect) btnDisconnect.style.display = "inline-block";
  } else {
    if (badge) {
      badge.textContent = "Not connected";
      badge.style.background = "#FEF3C7";
      badge.style.color = "#92400E";
      badge.style.borderColor = "#FDE68A";
    }
    if (connInfo) connInfo.style.display = "none";
    if (btnConnect) btnConnect.style.display = "inline-block";
    if (btnChange) btnChange.style.display = "none";
    if (btnDisconnect) btnDisconnect.style.display = "none";
  }
}

function updateOverviewSourcesSummary(sources) {
  const gsc = sources.google_search_console?.connected;
  const ga4 = sources.google_analytics?.connected;
  const bing = sources.bing_webmaster?.connected;

  const connectedCount = [gsc, ga4, bing].filter(Boolean).length;
  const dpIntegrations = document.getElementById("dp-integrations");
  const dpStatus = document.getElementById("dp-status");

  if (dpIntegrations) {
    if (connectedCount === 0) {
      dpIntegrations.textContent = "Not connected yet";
      dpIntegrations.style.color = "#D97706";
    } else if (connectedCount === 3) {
      dpIntegrations.textContent = "All 3 connected ✓";
      dpIntegrations.style.color = "var(--green)";
    } else {
      dpIntegrations.textContent = `${connectedCount} of 3 connected ✓`;
      dpIntegrations.style.color = "var(--green)";
    }
  }

  if (dpStatus) {
    if (sources.google_analytics?.actionRequired) {
      dpStatus.textContent = `⚠️ GA4 action required: ${sources.google_analytics.statusMessage || "Please check connection"}`;
      dpStatus.style.color = "#DC2626";
    } else if (connectedCount > 0) {
      const selectedNames = [
        sources.google_search_console?.selectedProperty?.name,
        sources.google_analytics?.selectedProperty?.name,
        sources.bing_webmaster?.selectedProperty?.name,
      ].filter(Boolean);

      if (selectedNames.length > 0) {
        dpStatus.textContent = `Monitoring configured for: ${selectedNames[0]}`;
        dpStatus.style.color = "var(--text)";
      } else {
        dpStatus.textContent = "Connected. Select properties to begin monitoring.";
        dpStatus.style.color = "#D97706";
      }
    } else {
      dpStatus.textContent = "Begins after data sources connect";
      dpStatus.style.color = "var(--muted)";
    }
  }
}

async function initiateOAuth(provider) {
  const token = localStorage.getItem(STORAGE.token);
  if (!token) {
    openAuthModal("login");
    toast("Please sign in or create an account first.");
    return;
  }

  const prefix = provider === "google_search_console" ? "gsc" : provider === "google_analytics" ? "ga4" : "bing";
  const btn = document.getElementById(`btn-connect-${prefix}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Connecting…";
  }

  // Open popup synchronously during user click to prevent browser popup blockers
  let popup = null;
  try {
    popup = window.open(
      "about:blank",
      "sharflow_oauth_window",
      "width=600,height=720,menubar=no,toolbar=no,status=no,location=yes,scrollbars=yes,resizable=yes"
    );
    if (popup) {
      try {
        const providerName = provider === "bing_webmaster" ? "Bing Webmaster Tools" : provider === "google_analytics" ? "Google Analytics" : "Google Search Console";
        popup.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connecting to ${providerName}…</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#FAF9F5;color:#1E1E1C;font-size:14px;text-align:center;padding:20px;}</style></head><body><div><div style="font-size:24px;margin-bottom:12px;">⏳</div><div>Connecting to ${providerName}…</div></div></body></html>`);
        popup.document.close();
      } catch {}
    }
  } catch (popupErr) {
    console.warn("Could not open synchronous popup:", popupErr);
  }

  try {
    const origin = window.location.origin;
    const returnUrl = `${origin}/#sources`;
    const res = await fetch(`/api/oauth?action=url&provider=${encodeURIComponent(provider)}&origin=${encodeURIComponent(origin)}&returnUrl=${encodeURIComponent(returnUrl)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (popup && !popup.closed) popup.close();
      toast(data.error || "Failed to start OAuth connection.");
      return;
    }

    if (data.connectedDirectly) {
      if (popup && !popup.closed) popup.close();
      toast(data.message || "Connected via existing Google authorization!");
      await loadDataSources();
      await loadProperties(provider);
      return;
    }

    if (!popup || popup.closed) {
      toast("Popup was blocked by your browser. Please allow popups for this site.");
      return;
    }

    popup.location.href = data.url;
    if (popup.focus) popup.focus();
  } catch (err) {
    if (popup && !popup.closed) popup.close();
    toast("Connection error: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = provider === "bing_webmaster" ? "Connect Bing →" : provider === "google_analytics" ? "Connect Analytics →" : "Connect Search Console →";
    }
  }
}

async function loadProperties(provider) {
  const token = localStorage.getItem(STORAGE.token);
  if (!token) return;

  const prefix = provider === "google_search_console" ? "gsc" : provider === "google_analytics" ? "ga4" : "bing";
  const picker = document.getElementById(`${prefix}-picker`);
  const select = document.getElementById(`${prefix}-select`);
  const btnChange = document.getElementById(`btn-change-${prefix}`);

  if (btnChange) {
    btnChange.disabled = true;
    btnChange.textContent = "Loading properties…";
  }

  try {
    const res = await fetch(`/api/datasources?action=properties&provider=${encodeURIComponent(provider)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      toast(data.error || "Could not retrieve accessible properties.");
      return;
    }

    const properties = data.properties || [];
    if (properties.length === 0) {
      toast("No properties found in this account. Please verify your website in the provider console first.");
      return;
    }

    if (select) {
      select.innerHTML = "";
      const form = getSavedForm();
      const userDomain = (form.websiteUrl || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

      let autoSelected = false;
      properties.forEach((prop, idx) => {
        const opt = document.createElement("option");
        opt.value = prop.id;
        opt.textContent = prop.name || prop.id;
        opt.dataset.prop = JSON.stringify(prop);

        // Preselect matching website domain
        const propStr = (prop.id + " " + (prop.name || "")).toLowerCase();
        if (userDomain && propStr.includes(userDomain) && !autoSelected) {
          opt.selected = true;
          autoSelected = true;
        } else if (idx === 0 && !autoSelected) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    }

    if (picker) picker.style.display = "block";
  } catch (err) {
    toast("Failed to load properties: " + err.message);
  } finally {
    if (btnChange) {
      btnChange.disabled = false;
      btnChange.textContent = provider === "bing_webmaster" ? "Change Site" : "Change Property";
    }
  }
}

function hidePropertyPicker(provider) {
  const prefix = provider === "google_search_console" ? "gsc" : provider === "google_analytics" ? "ga4" : "bing";
  const picker = document.getElementById(`${prefix}-picker`);
  if (picker) picker.style.display = "none";
}

async function saveSelectedProperty(provider) {
  const token = localStorage.getItem(STORAGE.token);
  if (!token) return;

  const prefix = provider === "google_search_console" ? "gsc" : provider === "google_analytics" ? "ga4" : "bing";
  const select = document.getElementById(`${prefix}-select`);
  const btn = document.getElementById(`btn-save-${prefix}`);

  if (!select || !select.value) {
    toast("Please choose a property from the list.");
    return;
  }

  const selectedOpt = select.options[select.selectedIndex];
  let propertyObj = { id: select.value, name: selectedOpt.textContent };
  try {
    if (selectedOpt.dataset.prop) {
      propertyObj = JSON.parse(selectedOpt.dataset.prop);
    }
  } catch {}

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }

  try {
    const res = await fetch("/api/datasources", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        action: "select_property",
        provider,
        property: propertyObj,
      }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      toast(data.error || "Failed to save property.");
      return;
    }

    hidePropertyPicker(provider);
    toast("Property saved! Sharflow Watchdog monitoring updated.");
    await loadDataSources();
  } catch (err) {
    toast("Error saving property: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = provider === "bing_webmaster" ? "Confirm Site ✓" : "Confirm Property ✓";
    }
  }
}

async function disconnectDataSource(provider) {
  const providerTitle = provider === "bing_webmaster" ? "Bing Webmaster" : provider === "google_analytics" ? "Google Analytics" : "Google Search Console";
  if (!confirm(`Are you sure you want to disconnect ${providerTitle}?`)) {
    return;
  }

  const token = localStorage.getItem(STORAGE.token);
  if (!token) return;

  try {
    const res = await fetch("/api/datasources", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: "disconnect", provider }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      toast(data.error || "Failed to disconnect data source.");
      return;
    }

    toast(`${providerTitle} disconnected.`);
    hidePropertyPicker(provider);
    await loadDataSources();
  } catch (err) {
    toast("Disconnect error: " + err.message);
  }
}

// Global OAuth popup message listener
window.addEventListener("message", async (event) => {
  // Validate sender origin matches current window origin or trusted Sharflow domain
  const origin = event.origin || "";
  const isTrusted =
    origin === window.location.origin ||
    origin === "https://sharflow.online" ||
    origin === "https://www.sharflow.online" ||
    origin === "https://sharflow.com" ||
    origin === "https://www.sharflow.com" ||
    origin.endsWith(".run.app") ||
    origin.endsWith(".vercel.app") ||
    origin.includes("localhost") ||
    origin.includes("127.0.0.1");

  if (!isTrusted) return;

  if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
    toast("Authorization successful! Loading available properties…");
    await loadDataSources();
    
    // Auto open property selection for the newly connected provider
    const prov = event.data.provider;
    if (prov === "google_search_console" || prov === "google") {
      loadProperties("google_search_console");
    } else if (prov === "google_analytics") {
      loadProperties("google_analytics");
    } else if (prov === "bing" || prov === "bing_webmaster") {
      loadProperties("bing_webmaster");
    }
  } else if (event.data?.type === "OAUTH_AUTH_ERROR") {
    toast("Connection failed: " + (event.data.error || "Authorization error."));
  }
});

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
window.initiateOAuth = initiateOAuth;
window.loadProperties = loadProperties;
window.hidePropertyPicker = hidePropertyPicker;
window.saveSelectedProperty = saveSelectedProperty;
window.disconnectDataSource = disconnectDataSource;
window.loadDataSources = loadDataSources;
window.exportReportCSV = exportReportCSV;
window.toggleProfilePreferencesEditor = toggleProfilePreferencesEditor;
window.renderProfilePreferencesEditor = renderProfilePreferencesEditor;
window.saveProfilePreferences = saveProfilePreferences;
window.openPaddleCheckout = openPaddleCheckout;
window.checkoutSharflowPro = checkoutSharflowPro;
window.updateBillingPanelUI = updateBillingPanelUI;
window.SHARFLOW_PRO_PRICE_ID = SHARFLOW_PRO_PRICE_ID;
