import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, addDoc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const myPrivateFirebaseConfig = {
    apiKey: "AIzaSyDmLx4dkZHzUGjc0BGMmBzUmh9Nm0EbJYg",
    authDomain: "atricure-app.firebaseapp.com",
    projectId: "atricure-app",
    storageBucket: "atricure-app.firebasestorage.app",
    messagingSenderId: "958693322940",
    appId: "1:958693322940:web:a8f8471becb3ded80420b9",
    measurementId: "G-S8Y8SL6MTB"
};

// EXPOSE CORE STATE & GLOBAL LIFECYCLE HANDLERS DIRECTLY TO WINDOW
let apiKey = ""; 
let db = null;
let auth = null;
let activeUser = null;
let isFirebaseActive = false;

window.apiKey = apiKey;
window.db = db;
window.auth = auth;
window.activeUser = activeUser;
window.isFirebaseActive = isFirebaseActive;
window.appId = typeof __app_id !== 'undefined' ? __app_id : 'atricure-clinical-hub';

const fallbackDatabase = [
    {
        id: "seed-1",
        title: "Five-Year Outcomes of the Cox-Maze IV Procedure for Atrial Fibrillation",
        author: "Damiano RJ, et al. / J Thorac Cardiovasc Surg",
        mainCategory: "MAZE",
        subCategory: "Rhythm Outcomes",
        headerGroup: "",
        url: "https://www.jtcvs.org",
        linkType: "journal",
        summary: "• Assessed long-term durability of the Cox-MAZE IV procedure using biatrial radiofrequency and cryoablation.\n• Freedom from AF at 5 years was 89% in patients undergoing stand-alone procedures.\n• Overall safety profile demonstrated negligible clinical deviations; procedural success tracked high durability over late-term tracking.",
        searchProfile: "cox maze iv damiano durability radiofrequency cryoablation stand alone biatrial five year outcomes 5 year"
    }
];

window.clinicalDatabase = [];
window.currentMainCategory = "Welcome";
window.currentSubCategory = "Home";
window.bookmarkedResourceIds = [];
window.isStarredFilterActive = false;
window.activeDeletionTargetId = null;
window.editingResourceId = null; 
window.activeAdminTab = 'single'; 
window.bulkSortField = 'title'; 
window.bulkSortAsc = true;

// GLOBAL BROADCAST TIMELINE APP STATE REGISTER VARIABLES
window.activeBroadcastLogs = [];
window.isBroadcastExpanded = false;

const placeholderPhrases = [
    "\'Show me 10-year success rates for Cox-MAZE IV\'",
    "\'Show the data on prophylactic clipping\'",
    "\'List the papers by Dr. McCarthy\'",
    "\'IFU for the Cryo3\'",
    "\'Give me the information we have on EnCompass\'"
];
let currentPlaceholderIndex = 0;
let placeholderTimer = null;

window.escapeHtml = function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

window.formatGoogleDriveLink = function(url) {
    if (!url) return "";
    let formattedUrl = url.trim();
    
    const fileDMatch = formattedUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileDMatch) {
        const fileId = fileDMatch[1];
        return `https://drive.google.com/file/d/${fileId}/preview`;
    }
    
    const openIdMatch = formattedUrl.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
    if (openIdMatch) {
        const fileId = openIdMatch[1];
        return `https://drive.google.com/file/d/${fileId}/preview`;
    }

    const docsDMatch = formattedUrl.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (docsDMatch) {
        const fileId = docsDMatch[1];
        return `https://docs.google.com/document/d/${fileId}/preview`;
    }
    
    return formattedUrl;
};

window.normalizeDocument = function(doc) {
    let mCat = String(doc.mainCategory || "").trim();
    let sCat = String(doc.subCategory || "").trim();
    let normalizedMain = "MAZE";
    let mCatLower = mCat.toLowerCase();
    
    if (mCatLower.includes("maze")) {
        normalizedMain = "MAZE";
    } else if (mCatLower.includes("laa") || mCatLower.includes("appendage")) {
        normalizedMain = "LAA";
    } else if (mCatLower.includes("device") || mCatLower.includes("resource") || mCatLower.includes("ablation") || mCatLower.includes("cryo") || mCatLower.includes("clips") || mCatLower.includes("ifu")) {
        normalizedMain = "Device Resources";
    } else if (mCatLower.includes("misc") || mCatLower.includes("guideline") || mCatLower.includes("training") || mCatLower.includes("common")) {
        normalizedMain = "MISC";
    }

    let normalizedSub = "General"; 
    let sCatLower = sCat.toLowerCase();

    if (normalizedMain === "MAZE") {
        if (sCatLower.includes("survival") || sCatLower.includes("benefit") || sCatLower.includes("mortality") || sCatLower.includes("cost")) {
            normalizedSub = "Survival Benefits";
        } else if (sCatLower.includes("encompass") || sCatLower.includes("clamp") || sCatLower.includes("prophylactic") || sCatLower.includes("prevent") || sCatLower.includes("other") || sCatLower.includes("technique") || sCatLower.includes("how")) {
            normalizedSub = "Other";
        } else {
            normalizedSub = "Rhythm Outcomes";
        }
    } else if (normalizedMain === "LAA") {
        if (sCatLower.includes("stroke") || sCatLower.includes("reduction")) {
            normalizedSub = "Stroke Reduction";
        } else if (sCatLower.includes("prophylactic") || sCatLower.includes("prevent")) {
            normalizedSub = "Prophylactic Data";
        } else {
            normalizedSub = "Outcomes and Safety";
        }
    } else if (normalizedMain === "Device Resources") {
        if (sCatLower.includes("ifu") || sCatLower.includes("instructions")) {
            normalizedSub = "IFUs";
        } else if (sCatLower.includes("brochure") || sCatLower.includes("pamphlet") || sCatLower.includes("catalog")) {
            normalizedSub = "Product Brochures";
        } else {
            normalizedSub = "Other Media";
        }
    } else if (normalizedMain === "MISC") {
        if (sCatLower.includes("research") || sCatLower.includes("trial") || sCatLower.includes("misc") || sCatLower.includes("other")) {
            normalizedSub = "Other Research";
        } else {
            normalizedSub = "Helpful Documents";
        }
    }
    return { ...doc, mainCategory: normalizedMain, subCategory: normalizedSub };
};

window.startPlaceholderRotation = function() {
    if (placeholderTimer) clearInterval(placeholderTimer);
    const input = document.getElementById("copilotQueryInput");
    if (input) input.placeholder = placeholderPhrases[0];
    placeholderTimer = setInterval(window.executePlaceholderTransitionStep, 4000);
};

window.executePlaceholderTransitionStep = function() {
    const input = document.getElementById("copilotQueryInput");
    if (!input) return;
    input.classList.add("placeholder-fade-out");
    setTimeout(() => {
        currentPlaceholderIndex = (currentPlaceholderIndex + 1) % placeholderPhrases.length;
        input.placeholder = placeholderPhrases[currentPlaceholderIndex];
        input.classList.remove("placeholder-fade-out");
    }, 500); 
};

window.attemptInitializeFirebase = async function() {
    const syncIndicator = document.getElementById("syncStatus");
    try {
        const hasValidPrivateConfig = myPrivateFirebaseConfig && myPrivateFirebaseConfig.apiKey !== "YOUR_API_KEY";
        const hasEnvConfig = typeof __firebase_config !== 'undefined' && __firebase_config;

        if (hasValidPrivateConfig || hasEnvConfig) {
            const finalConfig = hasValidPrivateConfig ? myPrivateFirebaseConfig : JSON.parse(__firebase_config);
            const app = initializeApp(finalConfig);
            auth = getAuth(app);
            db = getFirestore(app);
            window.auth = auth;
            window.db = db;

            await signInAnonymously(auth);

            onAuthStateChanged(auth, (user) => {
                if (user) {
                    activeUser = user;
                    isFirebaseActive = true;
                    syncIndicator.innerHTML = `<span class="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span><span>Cloud Synced</span>`;
                    window.showToast("Cloud database connected successfully.", "success");
                    
                    // 🚀 FIXED: Trigger the database streams downstream download execution layout
                    window.subscribeToDatabaseStreams();
                    window.loadSecureApiKey();
                } else {
                    isFirebaseActive = false;
                    window.loadLocalFallbackData();
                }
            });
        } else {
            window.loadLocalFallbackData();
        }
    } catch (err) {
        window.loadLocalFallbackData();
    }
};

window.loadSecureApiKey = async function() {
    if (!window.db) return;
    try {
        const docRef = doc(window.db, 'artifacts', 'atricure-clinical-hub', 'public', 'data', 'config', 'gemini');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            window.apiKey = docSnap.data().key || "";
            window.updateApiKeyStatusUI(window.apiKey ? true : false);
        } else {
            window.updateApiKeyStatusUI(false);
        }
    } catch (err) { window.updateApiKeyStatusUI(false); }
};

window.updateApiKeyStatusUI = function(isLoaded) {
    const badge = document.getElementById("apiKeyStatusBadge");
    if (badge) {
        // FIXED: Now checking window.apiKey instead of the dead local variable
        if (isLoaded && window.apiKey) {
            badge.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 flex items-center gap-1";
            badge.innerHTML = `<span class="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span><span>Key Safe & Active</span>`;
        } else {
            badge.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-red-100 text-red-800 flex items-center gap-1";
            badge.innerHTML = `<span class="w-1.5 h-1.5 bg-red-500 rounded-full"></span><span>No Key Loaded</span>`;
        }
    }
};

// 🚀 FIXED: Extracted to the global module layer so execution sequences compile seamlessly
window.subscribeToDatabaseStreams = function() {
    if (!isFirebaseActive || !activeUser) return;
    
    // Channel A: Clinical Studies Registry Snapshot Channel
    const publicDataCollection = collection(db, 'artifacts', 'atricure-clinical-hub', 'public', 'data', 'clinicalResources');
    onSnapshot(publicDataCollection, (snapshot) => {
        const cloudDocs = [];
        snapshot.forEach(doc => { cloudDocs.push(window.normalizeDocument({ id: doc.id, ...doc.data() })); });
        if (cloudDocs.length === 0) {
            window.seedLocalDataToCloud();
        } else {
            clinicalDatabase = cloudDocs;
            window.updateSidebarActiveStates();
            window.renderAppViewboard();
            window.renderAdminInventory();
            if (window.activeAdminTab === 'bulk') window.renderSpreadsheetWorkspace();
        }
    }, (error) => {
        console.error("Firestore subscription snapshot breakdown:", error);
    });

    // Channel B: Live System Broadcast Timeline logs Real-time Data pipeline
    const broadcastCollection = collection(db, 'artifacts', 'atricure-clinical-hub', 'public', 'data', 'systemAnnouncements');
    onSnapshot(broadcastCollection, (snapshot) => {
        const logs = [];
        snapshot.forEach(doc => { logs.push({ id: doc.id, ...doc.data() }); });
        
        // Stabilize descending timeline indices order
        logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        window.activeBroadcastLogs = logs;
        
        // Execute instant updates to layout layers across standard views and management view frames
        window.renderLiveBroadcastTimeline();
        window.renderAdminBroadcastInventory();
    }, (error) => {
        console.error("System announcement log channel sync fault:", error);
    });
};

window.seedLocalDataToCloud = async function() {
    if (!isFirebaseActive || !activeUser) return;
    try {
        const publicDataCollection = collection(db, 'artifacts', 'atricure-clinical-hub', 'public', 'data', 'clinicalResources');
        for (const item of fallbackDatabase) { await addDoc(publicDataCollection, item); }
    } catch (err) {
        console.error("Failed to seed cloud registry:", err);
    }
};

window.loadLocalFallbackData = function() {
    const cached = localStorage.getItem("atricure_local_resources");
    if (cached) { clinicalDatabase = JSON.parse(cached); } 
    else {
        clinicalDatabase = [...fallbackDatabase];
        localStorage.setItem("atricure_local_resources", JSON.stringify(clinicalDatabase));
    }
    window.updateSidebarActiveStates();
    window.renderAppViewboard();
};

window.cleanAndParseJSON = function(rawStr) {
    const start = rawStr.indexOf('{');
    const end = rawStr.lastIndexOf('}');
    if (start === -1 || end === -1) {
        throw new Error("Response structural anomaly detected during extraction.");
    }
    const jsonText = rawStr.substring(start, end + 1);
    return JSON.parse(jsonText);
};

window.callGeminiAPI = async function(systemPrompt, userQuery) {
    // FIXED: Now checking window.apiKey
    if (!window.apiKey) {
        throw new Error("No Gemini API key supplied in database configuration.");
    }
    const models = ["gemini-2.5-flash", "gemini-2.5-flash-preview-09-2025", "gemini-1.5-flash"];
    let lastError = null;

    for (const model of models) {
        try {
            // FIXED: Injecting window.apiKey into the fetch URL
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${window.apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: userQuery }] }],
                    systemInstruction: { parts: [{ text: systemPrompt }] }
                })
            });
            
            if (response.ok) {
                const payload = await response.json();
                const resultText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
                if (resultText) return resultText;
            }
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error("AI Routing timed out on all system matrices.");
};

window.closeAISearchOverlay = function() {
    document.getElementById("aiSearchOverlay").classList.add("hidden");
    const queryArea = document.getElementById("copilotQueryInput");
    if (queryArea) queryArea.value = "";
};

window.askAtriGuide = async function() {
    const queryArea = document.getElementById("copilotQueryInput");
    const btn = document.getElementById("copilotSubmitBtn");
    const query = queryArea.value.trim();

    if (!query) {
        window.showToast("Please enter a question or topic for AtriGuide to analyze.", "warning");
        return;
    }

    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="sparkles" class="w-3.5 h-3.5 text-orange-500 animate-spin"></i><span>Analyzing...</span>`;
    lucide.createIcons();

    document.getElementById("aiSearchOverlay").classList.remove("hidden");
    const syncBox = document.getElementById("aiSynthesisBox");
    const cardsContainer = document.getElementById("aiCardsContainer");
    
    syncBox.classList.remove("hidden");
    
    // 🚀 FIXED LOADING TEXT: Perfectly punchy and field-ready
    document.getElementById("aiSynthesisText").innerHTML = "AtriGuide AI is retrieving relevant papers and generating key insights...";
    
    // The animated pulse target matching your trial logs
    cardsContainer.innerHTML = `<div class="flex items-center space-x-2 text-slate-400 text-xs font-semibold py-8 justify-center"><span class="w-2 h-2 bg-orange-500 rounded-full animate-ping"></span><span>Locating target trial logs...</span></div>`;

    const catalogContext = clinicalDatabase.map(d => `ID: ${d.id} | Title: ${d.title} | Author: ${d.author} | SubCategory: ${d.subCategory} | Summary Elements: ${d.summary} | Keywords: ${d.searchProfile || ""}`).join("\n");

    const systemPrompt = `You are a precision clinical data router for AtriCure medical reps. Your job is to read the field query and return a valid JSON object containing an executive synthesis answer and an array of matching doc IDs. Scan the provided keywords and deep summary elements thoroughly to find matches. If no studies match, return an empty array. Do not return markdown wraps or prose outside the JSON blocks. 
    Format exactly like this:
    {
        "synthesis": "A direct 2-3 sentence clinical answer compiled from the matching sources.",
        "matchedIds": ["doc-id-1", "doc-id-2"]
    }`;

    const userPrompt = `Database Catalog:\n${catalogContext}\n\nRep Query: ${query}`;

    try {
        const apiRawResult = await window.callGeminiAPI(systemPrompt, userPrompt);
        const parsedResult = window.cleanAndParseJSON(apiRawResult);

        // 🚀 FIXED OUTPUT TEXT: Formatted explicitly to show the polished terminology
        document.getElementById("aiSynthesisText").innerHTML = `<strong>Scrub Sink Summary:</strong><br>${parsedResult.synthesis || "No direct executive brief available."}`;
        
        const matches = clinicalDatabase.filter(d => (parsedResult.matchedIds || []).includes(d.id));
        
        if (matches.length > 0) {
            cardsContainer.innerHTML = matches.map((c, idx) => window.renderAtriGuideCard(c, idx + 1)).join('');
            window.showToast("Scrub Sink Summary populated successfully.", "success");
        } else {
            cardsContainer.innerHTML = `<div class="text-slate-400 font-semibold p-8 text-center text-xs">No explicit evidence cards support this concept. Try phrasing by specific parameters or device tags.</div>`;
        }
    } catch (err) {
        console.error("AI routing matrix connection anomaly, using local multi-word keyword fallback loop:", err);
        
        document.getElementById("aiSynthesisText").innerHTML = `⚠️ <strong>Offline / Standalone Search Active</strong><br>Displaying the best matched clinical papers from the local database index based on keyword matching relevance.`;

        const stopWords = ['what', 'show', 'me', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'in', 'on', 'at', 'of', 'by', 'this', 'that', 'about', 'results', 'studies', 'study', 'papers', 'paper', 'data', 'evidence', 'find', 'search', 'how', 'we', 'have'];
        const searchWords = query.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 1 && !stopWords.includes(word));

        let scoredMatches = [];
        if (searchWords.length > 0 && clinicalDatabase.length > 0) {
            clinicalDatabase.forEach(doc => {
                let score = 0;
                const titleLower = String(doc.title || "").toLowerCase();
                const authorLower = String(doc.author || "").toLowerCase();
                const summaryLower = String(doc.summary || "").toLowerCase();
                const mCatLower = String(doc.mainCategory || "").toLowerCase();
                const sCatLower = String(doc.subCategory || "").toLowerCase();
                const profileLower = String(doc.searchProfile || "").toLowerCase();

                searchWords.forEach(word => {
                    if (titleLower.includes(word)) score += 15;
                    if (authorLower.includes(word)) score += 15; 
                    if (profileLower.includes(word)) score += 10; 
                    if (summaryLower.includes(word)) score += 6;
                    if (mCatLower.includes(word) || sCatLower.includes(word)) score += 3;
                });

                if (score > 0) {
                    scoredMatches.push({ doc, score });
                }
            });
            scoredMatches.sort((a, b) => b.score - a.score);
        }

        const finalLocalMatches = scoredMatches.map(sm => sm.doc);

        if (finalLocalMatches.length > 0) {
            cardsContainer.innerHTML = finalLocalMatches.map((c, idx) => window.renderAtriGuideCard(c, idx + 1)).join('');
            window.showToast("Local engine retrieved " + finalLocalMatches.length + " matching papers.", "success");
        } else {
            cardsContainer.innerHTML = `
                <div class="text-slate-400 font-semibold p-8 text-center text-xs">
                    No matching items found for "${window.escapeHtml(query)}" offline.<br>
                    <span class="text-slate-350 block mt-1 font-normal">Try searching with simplified terms like "Whitlock", "Damiano", "EnCompass", or "LAAOS".</span>
                </div>`;
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="sparkles" class="w-4 h-4 text-white"></i><span>✨ Ask AtriGuide</span>`;
        lucide.createIcons();
    }
};

window.closeMobileMenu = function() {
    const sidebar = document.getElementById("sidebarMenu");
    const overlay = document.getElementById("sidebarOverlay");
    if (sidebar && !sidebar.classList.contains("-translate-x-full")) {
        sidebar.classList.add("-translate-x-full");
    }
    if (overlay && !overlay.classList.contains("hidden")) {
        overlay.classList.remove("opacity-100");
        overlay.classList.add("opacity-0");
        setTimeout(() => { overlay.classList.add("hidden"); }, 300);
    }
};

window.toggleMobileMenu = function() {
    const sidebar = document.getElementById("sidebarMenu");
    const overlay = document.getElementById("sidebarOverlay");
    if (sidebar.classList.contains("-translate-x-full")) {
        sidebar.classList.remove("-translate-x-full");
        overlay.classList.remove("hidden");
        setTimeout(() => {
            overlay.classList.remove("opacity-0");
            overlay.classList.add("opacity-100");
        }, 10);
    } else {
        sidebar.classList.add("-translate-x-full");
        overlay.classList.remove("opacity-100");
        overlay.classList.add("opacity-0");
        setTimeout(() => { overlay.classList.add("hidden"); }, 300);
    }
};

window.loadStarredCache = function() {
    const stars = localStorage.getItem("atricure_starred_resources");
    if (stars) { window.bookmarkedResourceIds = JSON.parse(stars); }
    window.updateStarredBadge();
};

window.saveStarredCache = function() {
    localStorage.setItem("atricure_starred_resources", JSON.stringify(window.bookmarkedResourceIds));
    window.updateStarredBadge();
};

window.updateStarredBadge = function() {
    const badge = document.getElementById("starBadgeCount");
    const btn = document.getElementById("starredQuickBtn");
    const count = window.bookmarkedResourceIds.length;
    if (count > 0) {
        badge.innerText = count;
        badge.classList.remove("hidden");
        btn.classList.add("text-[#FF6B00]");
    } else {
        badge.className = "hidden";
        btn.classList.remove("text-[#FF6B00]");
    }
};

window.setupLocalEventListeners = function() {
    const categorySearchInput = document.getElementById("categorySearchInput");
    const clearCategorySearchBtn = document.getElementById("clearCategorySearchBtn");

    categorySearchInput.addEventListener("input", (e) => {
        const val = e.target.value;
        if(val.trim() !== "") clearCategorySearchBtn.classList.remove("hidden");
        else clearCategorySearchBtn.classList.add("hidden");
        window.renderAppViewboard();
    });

    clearCategorySearchBtn.addEventListener("click", () => {
        categorySearchInput.value = "";
        clearCategorySearchBtn.classList.add("hidden");
        window.renderAppViewboard();
    });

    document.getElementById("mobileMenuBtn").addEventListener("click", () => {
        window.toggleMobileMenu();
    });

    document.getElementById("sidebarOverlay").addEventListener("click", () => {
        window.closeMobileMenu();
    });

    document.getElementById("adminPortalBtn").addEventListener("click", () => { window.openAdminAuthModal(); });
    document.getElementById("exitAdminBtn").addEventListener("click", () => { window.switchToView("user"); });
    document.getElementById("uploadForm").addEventListener("submit", (e) => { e.preventDefault(); window.processFormSubmission(); });
};

window.switchToView = function(viewMode) {
    const userView = document.getElementById("userDashboardView");
    const adminView = document.getElementById("adminPortalView");
    const bannerWrapper = document.getElementById("dynamicSystemBroadcastWrapper");
    
    if(viewMode === "admin") {
        userView.classList.add("hidden");
        if (bannerWrapper) bannerWrapper.classList.add("hidden");
        adminView.classList.remove("hidden");
        window.updateFormSubCategories();
        window.renderAdminInventory();
        window.renderAdminBroadcastInventory();
        if (window.activeAdminTab === 'bulk') window.renderSpreadsheetWorkspace();
    } else {
        adminView.classList.add("hidden");
        userView.classList.remove("hidden");
        if (bannerWrapper) bannerWrapper.classList.remove("hidden");
        window.renderAppViewboard();
    }
    window.closeMobileMenu();
};

window.navigateToHome = function() {
    window.currentMainCategory = "Welcome";
    window.currentSubCategory = "Home";
    window.isStarredFilterActive = false;
    document.getElementById("categorySearchContainer").classList.add("hidden");
    window.closeMobileMenu();
    window.renderAppViewboard();
};

window.selectSubCategory = function(mainCat, subCat) {
    window.currentMainCategory = mainCat;
    window.currentSubCategory = subCat;
    window.isStarredFilterActive = false;
    document.getElementById("categorySearchContainer").classList.remove("hidden");
    window.closeMobileMenu();
    window.renderAppViewboard();
};

window.toggleCategory = function(menuId) {
    const menu = document.getElementById(menuId);
    if(menu.classList.contains("hidden")) menu.classList.remove("hidden");
    else menu.classList.add("hidden");
};

window.toggleStarredFilter = function() {
    window.isStarredFilterActive = !window.isStarredFilterActive;
    const indicator = document.getElementById("starredFilterIndicator");
    if (window.isStarredFilterActive) {
        indicator.classList.remove("hidden");
        indicator.classList.add("flex");
        document.getElementById("breadcrumbMain").innerText = "Starred";
        document.getElementById("breadcrumbSub").innerText = "Personal Library";
    } else {
        indicator.className = "hidden";
        window.navigateToHome();
    }
    window.closeMobileMenu();
    window.renderAppViewboard();
};

window.toggleStarItem = function(id) {
    const idx = window.bookmarkedResourceIds.indexOf(id);
    if (idx === -1) {
        window.bookmarkedResourceIds.push(id);
        window.showToast("Added item to personal star reference library.", "success");
    } else {
        window.bookmarkedResourceIds.splice(idx, 1);
        window.showToast("Removed item from star reference registers.", "info");
    }
    window.saveStarredCache();
    window.renderAppViewboard();
};

window.updateSidebarActiveStates = function() {
    const counts = {
        "maze-rhythm": 0, "maze-survival": 0, "maze-other": 0,
        "laa-outcomes": 0, "laa-stroke": 0, "laa-prophylactic": 0,
        "dev-ifus": 0, "dev-brochures": 0, "dev-media": 0, 
        "misc-research": 0, "misc-helpful": 0
    };
    window.clinicalDatabase.forEach(d => {
        const mCat = d.mainCategory ? String(d.mainCategory).toLowerCase() : "";
        const sCat = d.subCategory ? String(d.subCategory).toLowerCase() : "";
        if (mCat === "maze") {
            if (sCat === "survival benefits") counts["maze-survival"]++;
            else if (sCat === "other") counts["maze-other"]++;
            else counts["maze-rhythm"]++;
        } else if (mCat === "laa") {
            if (sCat.includes("stroke")) counts["laa-stroke"]++;
            else if (sCat.includes("prophylactic")) counts["laa-prophylactic"]++;
            else counts["laa-outcomes"]++;
        } else if (mCat === "device resources") {
            if (sCat === "ifus") counts["dev-ifus"]++;
            else if (sCat === "product brochures") counts["dev-brochures"]++;
            else if (sCat === "other media") counts["dev-media"]++;
        } else if (mCat === "misc") {
            if (sCat === "other research") counts["misc-research"]++;
            else counts["misc-helpful"]++;
        }
    });
    for (const id in counts) {
        const el = document.getElementById(`count-${id}`);
        if (el) el.innerText = counts[id];
    }
};

window.renderAppViewboard = function() {
    const container = document.getElementById("userDashboardView");
    const bannerWrapper = document.getElementById("dynamicSystemBroadcastWrapper");
    
    if (window.currentMainCategory === "Welcome" && !window.isStarredFilterActive) {
        if (bannerWrapper) bannerWrapper.classList.remove("hidden");
        window.renderWelcomeScreen(container);
        window.startPlaceholderRotation();
        window.renderLiveBroadcastTimeline();
        return;
    }
    
    // Hide accordion if browsing clinical nested card parameters
    if (bannerWrapper) bannerWrapper.classList.add("hidden");

    const categorySearchInput = document.getElementById("categorySearchInput");
    const filterText = categorySearchInput ? categorySearchInput.value.toLowerCase().trim() : "";

    let workingDataSet = window.clinicalDatabase;
    if (window.isStarredFilterActive) {
        workingDataSet = window.clinicalDatabase.filter(doc => window.bookmarkedResourceIds.includes(doc.id));
        document.getElementById("breadcrumbMain").innerText = "Starred";
        document.getElementById("breadcrumbSub").innerText = "Personal Library";
    } else {
        workingDataSet = window.clinicalDatabase.filter(doc => doc.mainCategory === window.currentMainCategory && doc.subCategory === window.currentSubCategory);
        document.getElementById("breadcrumbMain").innerText = window.currentMainCategory;
        document.getElementById("breadcrumbSub").innerText = window.currentSubCategory;
    }

    if(filterText !== "") {
        workingDataSet = workingDataSet.filter(d => 
            String(d.title || "").toLowerCase().includes(filterText) ||
            String(d.author || "").toLowerCase().includes(filterText) ||
            String(d.summary || "").toLowerCase().includes(filterText) ||
            String(d.searchProfile || "").toLowerCase().includes(filterText)
        );
    }

    container.innerHTML = `
        <div class="space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${workingDataSet.map((c, i) => window.renderAtriGuideCard(c, i + 1)).join('')}
            </div>
        </div>`;
    lucide.createIcons();
};

window.renderWelcomeScreen = function(container) {
    container.innerHTML = `
        <div class="space-y-8 animate-fade-in pb-12">
            <div class="bg-[#00205B] border-l-[6px] border-[#FF6B00] rounded-2xl p-6 shadow-lg space-y-5 relative overflow-hidden">
                <div class="absolute right-0 bottom-0 translate-x-8 translate-y-8 opacity-5 text-white pointer-events-none">
                    <i data-lucide="sparkles" class="w-48 h-48"></i>
                </div>
                <div class="flex items-center space-x-3 relative z-10">
                    <div class="p-2 bg-white/10 text-[#FF6B00] rounded-lg">
                        <i data-lucide="sparkles" class="w-6 h-6 text-[#FF6B00]"></i>
                    </div>
                    <div>
                        <h3 class="font-extrabold text-white text-lg md:text-xl tracking-tight">AtriGuide AI</h3>
                        <p class="text-[11px] text-[#FF6B00] font-bold uppercase tracking-wider">Your clinical database, simplified.</p>
                    </div>
                </div>

                <p class="text-white/95 text-xs md:text-sm leading-relaxed max-w-2xl relative z-10 font-medium">
                    An AI-powered engine that instantly finds and retrieves matching research articles, IFUs, and media from a curated library of AtriCure-relevant data.
                </p>

                <div class="space-y-4 pt-1 relative z-10">
                    <textarea id="copilotQueryInput" rows="2" class="w-full text-slate-900 placeholder-slate-500 text-sm bg-white rounded-xl p-3.5 focus:outline-none focus:ring-2 focus:ring-orange-500 transition-all font-medium border-0 shadow-inner resize-none"></textarea>
                    <div class="flex flex-col sm:flex-row items-center justify-between gap-3">
                        <span class="text-[11px] text-slate-300 font-medium order-2 sm:order-1">Powered by Gemini 2.5 Flash</span>
                        <button onclick="askAtriGuide()" id="copilotSubmitBtn" class="w-full sm:w-auto sm:px-8 order-1 sm:order-2 bg-[#FF6B00] hover:bg-orange-600 text-white font-extrabold text-sm py-3 rounded-xl transition-all shadow-md hover:shadow-lg active:scale-[0.98] flex items-center justify-center space-x-2 cursor-pointer">
                            <i data-lucide="sparkles" class="w-4 h-4 text-white"></i>
                            <span>✨ Ask AtriGuide</span>
                        </button>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div class="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between">
                    <div class="space-y-3">
                        <div class="p-3 bg-blue-50 text-[#00205B] rounded-lg w-fit">
                            <i data-lucide="search" class="w-5 h-5 text-[#00205B]"></i>
                        </div>
                        <h3 class="font-bold text-slate-800 text-sm md:text-base">Instant Search</h3>
                        <p class="text-xs text-slate-500 leading-relaxed font-medium">
                            Type directly into AtriGuide. Search by author, specific trial, or type a clinical phrase to pull up relevant peer-reviewed articles instantly.
                        </p>
                    </div>
                </div>

                <div class="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between">
                    <div class="space-y-3">
                        <div class="p-3 bg-[#FF6B00]/10 text-[#FF6B00] rounded-lg w-fit">
                            <i data-lucide="menu" class="w-5 h-5 text-[#FF6B00]"></i>
                        </div>
                        <h3 class="font-bold text-slate-800 text-sm md:text-base">Browse the Database</h3>
                        <p class="text-xs text-slate-500 leading-relaxed font-medium">
                            Tap the menu icon (☰) at the top left to browse our hand-curated research categories manually, sorted directly by MAZE and LAA clinical topics.
                        </p>
                    </div>
                </div>

                <div class="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex flex-col justify-between">
                    <div class="space-y-3">
                        <div class="p-3 bg-amber-50 text-amber-500 rounded-lg w-fit">
                            <i data-lucide="star" class="w-5 h-5 text-amber-500"></i>
                        </div>
                        <h3 class="font-bold text-slate-800 text-sm md:text-base">Quick Access</h3>
                        <p class="text-xs text-slate-500 leading-relaxed font-medium">
                            Bookmark your most frequently referenced trials and device materials to save them directly to your personal dashboard.
                        </p>
                    </div>
                </div>
            </div>
        </div>`;
    lucide.createIcons();
};

window.renderAtriGuideCard = function(card, index) {
    const isStarred = window.bookmarkedResourceIds.includes(card.id);
    const cleanSummaryHtml = String(card.summary || "")
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => `<li class="flex items-start space-x-1.5"><span class="text-[#FF6B00] font-bold">•</span><span class="text-slate-600 text-xs leading-normal">${window.escapeHtml(line.replace(/^[•\-\*]\s*/, ''))}</span></li>`)
        .join('');

    let actionLinkButtonHtml = "";
    if (card.url && card.url.trim() !== "" && card.linkType !== "none") {
        const cleanDriveUrl = window.formatGoogleDriveLink(card.url);
        const isMedia = card.mainCategory === "Device Resources" && card.subCategory === "Other Media";
        const label = isMedia ? "View Media" : "View Document";
        const iconName = isMedia ? "video" : "external-link";
        
        const escapedUrl = window.escapeHtml(cleanDriveUrl);
        const escapedTitle = window.escapeHtml(card.title || "");

        actionLinkButtonHtml = `
            <div class="flex items-center space-x-1 shrink-0">
                <a href="${escapedUrl}" target="_blank" class="inline-flex items-center space-x-1.5 bg-[#FF6B00] hover:bg-[#00205B] text-white px-2.5 py-1.5 rounded-md font-extrabold transition-all duration-200 text-[10px] shadow-md hover:shadow-lg active:scale-95" title="Open preview panel directly">
                    <i data-lucide="${iconName}" class="w-3.5 h-3.5 text-white"></i>
                    <span>${label}</span>
                </a>
                <button onclick="window.generateQrCodePopstream('${escapedUrl}', '${escapedTitle}')" class="inline-flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-700 p-1.5 rounded-md transition-all border border-slate-200 shadow-sm active:scale-95 cursor-pointer" title="Generate immediate QR transfer stream for surgeons">
                    <i data-lucide="qr-code" class="w-3.5 h-3.5"></i>
                </button>
            </div>`;
    }

    return `
        <div class="bg-white border border-slate-200 rounded-lg p-4 flex flex-col justify-between shadow-sm relative group animate-fade-in">
            <div class="flex flex-col flex-1">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <h4 class="font-bold text-xs md:text-sm text-slate-800 tracking-tight leading-snug">${window.escapeHtml(card.title)}</h4>
                    <button onclick="toggleStarItem('${card.id}')" class="text-slate-300 hover:text-amber-500 p-0.5"><i data-lucide="star" class="w-4 h-4 ${isStarred ? 'text-amber-500 fill-amber-400' : ''}"></i></button>
                </div>
                
                <div class="flex items-center justify-between flex-wrap gap-2 text-[10px] text-slate-400 font-semibold mb-3">
                    <span class="bg-slate-100 text-slate-600 px-2.5 py-1 rounded truncate max-w-[200px] sm:max-w-[300px]">${window.escapeHtml(card.author)}</span>
                    ${actionLinkButtonHtml}
                </div>
                
                <div class="bg-slate-50 border border-slate-100/50 rounded p-2.5 flex-1">
                    <ul class="space-y-1 list-none pl-0">${cleanSummaryHtml}</ul>
                </div>
            </div>
        </div>`;
};

window.renderAdminInventory = function() {
    const listContainer = document.getElementById("adminInventoryList");
    if (!listContainer) return;
    
    const searchInput = document.getElementById("adminInventorySearch");
    const filterVal = searchInput ? searchInput.value.toLowerCase().trim() : "";

    let items = window.clinicalDatabase || [];
    if(filterVal !== "") {
        items = items.filter(d => 
            String(d && d.title || "").toLowerCase().includes(filterVal) || 
            String(d && d.author || "").toLowerCase().includes(filterVal)
        );
    }

    if(items.length === 0) {
        listContainer.innerHTML = `<div class="p-4 text-xs text-center text-slate-400 font-medium">No records found matching filters.</div>`;
        return;
    }

    try {
        listContainer.innerHTML = items.map(item => {
            if (!item) return '';
            const itemId = String(item.id || '');
            const title = String(item.title || 'Untitled');
            const author = String(item.author || 'Unknown Author');
            const mainCategory = String(item.mainCategory || 'MAZE');
            const subCategory = String(item.subCategory || 'General');

            const escapedTitle = window.escapeHtml(title);
            const escapedAuthor = window.escapeHtml(author);
            const escapedMainCat = window.escapeHtml(mainCategory);
            const escapedSubCat = window.escapeHtml(subCategory);

            return `
                <div class="p-3 bg-white flex items-center justify-between border-b border-slate-100 admin-inv-row" data-title="${escapedTitle.toLowerCase()}" data-author="${escapedAuthor.toLowerCase()}">
                    <div class="min-w-0 flex-1">
                        <h5 class="text-xs font-bold text-slate-800 truncate leading-tight">${escapedTitle}</h5>
                        <p class="text-[10px] font-medium text-slate-400 mt-0.5">${escapedMainCat} &gt; ${escapedSubCat}</p>
                    </div>
                    <div class="flex space-x-1 shrink-0 ml-2">
                        <button onclick="startEditingResource('${itemId}')" class="p-1 text-slate-400 hover:text-blue-900 cursor-pointer" title="Edit Resource"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                        <button onclick="triggerDeleteConfirmModal('${itemId}')" class="p-1 text-slate-400 hover:text-red-600 cursor-pointer" title="Delete Resource"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                </div>`;
        }).join('');
        lucide.createIcons();
    } catch (e) {
        console.error("renderAdminInventory crash logic intercepted:", e);
    }
};

window.filterAdminInventory = function() {
    const query = document.getElementById("adminInventorySearch").value.toLowerCase().trim();
    document.querySelectorAll(".admin-inv-row").forEach(row => {
        const t = row.getAttribute("data-title") || "";
        const a = row.getAttribute("data-author") || "";
        if(t.includes(query) || a.includes(query)) {
            row.classList.remove("hidden");
        } else {
            row.classList.add("hidden");
        }
    });
};

window.startEditingResource = function(id) {
    const item = window.clinicalDatabase.find(d => d.id === id);
    if (!item) {
        window.showToast("Target record missing.", "warning");
        return;
    }

    window.editingResourceId = id;

    document.getElementById("formTitle").value = item.title || "";
    document.getElementById("formAuthor").value = item.author || "";
    document.getElementById("formMainCat").value = item.mainCategory || "MAZE";
    
    window.updateFormSubCategories();
    document.getElementById("formSubCat").value = item.subCategory || "";
    document.getElementById("formUrl").value = item.url || "";
    document.getElementById("formLinkType").value = item.linkType || "journal";
    document.getElementById("formSummary").value = item.summary || "";

    document.getElementById("formPanelTitle").innerText = "Edit Existing Clinical Resource";
    document.getElementById("formHeaderIcon").setAttribute("data-lucide", "edit");
    document.getElementById("submitFormBtn").innerHTML = `<i data-lucide="check" class="w-4 h-4"></i><span>Save and Update Changes</span>`;
    document.getElementById("cancelEditBtn").classList.remove("hidden");

    document.getElementById("formTitle").scrollIntoView({ behavior: 'smooth' });
    lucide.createIcons();
    window.showToast("Clinical card loaded into editor workspace.", "info");
};

window.cancelEditingSession = function() {
    window.editingResourceId = null;
    document.getElementById("uploadForm").reset();

    document.getElementById("formPanelTitle").innerText = "Upload New Clinical Resource";
    document.getElementById("formHeaderIcon").setAttribute("data-lucide", "file-plus");
    document.getElementById("submitFormBtn").innerHTML = `<i data-lucide="upload-cloud" class="w-4 h-4"></i><span>Publish to Database Records</span>`;
    document.getElementById("cancelEditBtn").classList.add("hidden");

    lucide.createIcons();
};

window.processFormSubmission = async function() {
    const title = document.getElementById("formTitle").value;
    const author = document.getElementById("formAuthor").value;
    const mainCategory = document.getElementById("formMainCat").value;
    const subCategory = document.getElementById("formSubCat").value;
    const url = document.getElementById("formUrl").value || "";
    const linkType = document.getElementById("formLinkType").value || "journal";
    const summary = document.getElementById("formSummary").value;

    const resourceObject = {
        title: title.trim(),
        author: author.trim(),
        mainCategory: mainCategory,
        subCategory: subCategory,
        headerGroup: "",
        url: url.trim(),
        linkType: linkType,
        summary: summary.trim(),
        lastModifiedTimestamp: Date.now()
    };

    try {
        if (window.isFirebaseActive && db) {
            if (window.editingResourceId) {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', window.editingResourceId);
                await updateDoc(docRef, resourceObject);
            } else {
                resourceObject.createdTimestamp = Date.now();
                const collectionRef = collection(db, 'artifacts', appId, 'public', 'data', 'clinicalResources');
                await addDoc(collectionRef, resourceObject);
            }
        } else {
            if (window.editingResourceId) {
                const targetIdx = window.clinicalDatabase.findIndex(d => d.id === window.editingResourceId);
                if (targetIdx !== -1) {
                    resourceObject.id = window.editingResourceId;
                    window.clinicalDatabase[targetIdx] = resourceObject;
                }
            } else {
                resourceObject.id = "doc-" + Date.now();
                resourceObject.createdTimestamp = Date.now();
                window.clinicalDatabase.unshift(resourceObject);
            }
            localStorage.setItem("atricure_local_resources", JSON.stringify(window.clinicalDatabase));
            window.updateSidebarActiveStates();
            window.renderAppViewboard();
        }

        window.cancelEditingSession();
        window.showToast(window.editingResourceId ? "Resource record successfully updated in Firestore database!" : "Clinical Resource successfully created!", "success");
        window.renderAdminInventory();
    } catch (err) {
        console.error("Administrative storage transmission failed: ", err);
        window.showToast("System write tracking exception block intercepted form push.", "warning");
    }
};

window.triggerDeleteConfirmModal = function(id) {
    window.activeDeletionTargetId = id;
    const item = window.clinicalDatabase.find(d => d.id === id);
    const title = item ? item.title : "this entry";
    document.getElementById("deleteTargetTitle").innerText = `"${title}"`;
    
    const modal = document.getElementById("deleteConfirmModal");
    modal.classList.remove("hidden");
    
    const confirmBtn = document.getElementById("confirmDeleteBtn");
    confirmBtn.onclick = window.executeResourceDeletion;
    lucide.createIcons();
};

window.closeDeleteConfirmModal = function() {
    document.getElementById("deleteConfirmModal").classList.add("hidden");
    window.activeDeletionTargetId = null;
};

window.executeResourceDeletion = async function() {
    if (!window.activeDeletionTargetId) return;

    try {
        if (window.isFirebaseActive && db) {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', window.activeDeletionTargetId);
            await deleteDoc(docRef);
        } else {
            const index = window.clinicalDatabase.findIndex(d => d.id === window.activeDeletionTargetId);
            if (index !== -1) {
                window.clinicalDatabase.splice(index, 1);
                localStorage.setItem("atricure_local_resources", JSON.stringify(window.clinicalDatabase));
                window.updateSidebarActiveStates();
                window.renderAppViewboard();
            }
        }
        if (window.editingResourceId === window.activeDeletionTargetId) window.cancelEditingSession();
        window.showToast("Resource index removed from records.", "info");
        window.renderAdminInventory();
        window.closeDeleteConfirmModal();
    } catch (err) {
        console.error("Purge failure: " + err);
        window.showToast("Purging operation failed.", "warning");
    }
};

window.openAdminAuthModal = function() {
    const modal = document.getElementById("adminAuthModal");
    const input = document.getElementById("adminPasswordInput");
    const error = document.getElementById("adminAuthError");
    
    error.classList.add("hidden");
    input.value = "";
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 100);
    lucide.createIcons();
};

window.closeAdminAuthModal = function() {
    document.getElementById("adminAuthModal").classList.add("hidden");
};

window.verifyAdminAuthPassword = function() {
    const pin = document.getElementById("adminPasswordInput").value;
    const error = document.getElementById("adminAuthError");
    
    if (pin === "admin") {
        window.closeAdminAuthModal();
        window.switchToView("admin");
        window.showToast("System Access Authorized.", "success");
    } else {
        error.classList.remove("hidden");
    }
};

window.updateFormSubCategories = function() {
    const mainCat = document.getElementById("formMainCat").value;
    const subCatSelect = document.getElementById("formSubCat");
    let options = [];
    
    if (mainCat === "MAZE") {
        options = ["Rhythm Outcomes", "Survival Benefits", "Other"];
    } else if (mainCat === "LAA") {
        options = ["Outcomes and Safety", "Stroke Reduction", "Prophylactic Data"];
    } else if (mainCat === "Device Resources") {
        options = ["IFUs", "Product Brochures", "Other Media"];
    } else if (mainCat === "MISC") {
        options = ["Other Research", "Helpful Documents"];
    }
    
    subCatSelect.innerHTML = options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
};

window.exportDatabaseAsJSON = function() {
    const serializedData = JSON.stringify(window.clinicalDatabase, null, 4);
    const blob = new Blob([serializedData], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "atricure_updated_database.json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    window.showToast("Database exported successfully.", "success");
};

window.showToast = function(message, type = "info") {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = `p-3.5 rounded-xl shadow-xl border text-xs font-semibold bg-white ${type === "success" ? 'border-emerald-100 text-emerald-800 bg-emerald-50/90' : 'border-slate-100 text-slate-800'}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
};

window.setAdminTab = function(tab) {
    window.activeAdminTab = tab;
    const singleBtn = document.getElementById("adminTabSingle");
    const bulkBtn = document.getElementById("adminTabBulk");
    const singleView = document.getElementById("adminSingleView");
    const bulkView = document.getElementById("adminBulkView");
    
    if (tab === 'bulk') {
        singleBtn.className = "text-xs font-bold px-3 py-1.5 rounded-md text-slate-600 hover:text-slate-800 transition-all focus:outline-none cursor-pointer";
        bulkBtn.className = "text-xs font-bold px-3 py-1.5 rounded-md bg-white text-[#00205B] shadow transition-all focus:outline-none cursor-pointer";
        singleView.classList.add("hidden");
        bulkView.classList.remove("hidden");
        window.renderSpreadsheetWorkspace();
    } else {
        singleBtn.className = "text-xs font-bold px-3 py-1.5 rounded-md bg-white text-[#00205B] shadow transition-all focus:outline-none cursor-pointer";
        bulkBtn.className = "text-xs font-bold px-3 py-1.5 rounded-md text-slate-600 hover:text-slate-800 transition-all focus:outline-none cursor-pointer";
        singleView.classList.remove("hidden");
        bulkView.classList.add("hidden");
        window.renderAdminInventory();
    }
    lucide.createIcons();
};

window.sortBulkDatabase = function(field) {
    if (window.bulkSortField === field) {
        window.bulkSortAsc = !window.bulkSortAsc;
    } else {
        window.bulkSortField = field;
        window.bulkSortAsc = true;
    }
    window.renderSpreadsheetWorkspace();
};

window.renderSpreadsheetWorkspace = function() {
    const body = document.getElementById("bulkEditorTableBody");
    if (!body) return;

    let items = [...window.clinicalDatabase];
    items.sort((a, b) => {
        const valA = String(a[window.bulkSortField] || "").toLowerCase();
        const valB = String(b[window.bulkSortField] || "").toLowerCase();
        return window.bulkSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    });

    const titleIcon = document.getElementById("sort-icon-title");
    const authorIcon = document.getElementById("sort-icon-author");
    if (titleIcon && authorIcon) {
        titleIcon.setAttribute("data-lucide", window.bulkSortField === 'title' ? (window.bulkSortAsc ? "arrow-up" : "arrow-down") : "arrow-up-down");
        authorIcon.setAttribute("data-lucide", window.bulkSortField === 'author' ? (window.bulkSortAsc ? "arrow-up" : "arrow-down") : "arrow-up-down");
    }

    body.innerHTML = items.map(item => {
        const mainCat = item.mainCategory || "MAZE";
        const subCat = item.subCategory || "Rhythm Outcomes";
        
        const mazeSelected = mainCat === "MAZE" ? "selected" : "";
        const laaSelected = mainCat === "LAA" ? "selected" : "";
        const devSelected = mainCat === "Device Resources" ? "selected" : "";
        const miscSelected = mainCat === "MISC" ? "selected" : "";

        let subOptions = [];
        if (mainCat === "MAZE") subOptions = ["Rhythm Outcomes", "Survival Benefits", "Other"];
        else if (mainCat === "LAA") subOptions = ["Outcomes and Safety", "Stroke Reduction", "Prophylactic Data"];
        else if (mainCat === "Device Resources") subOptions = ["IFUs", "Product Brochures", "Other Media"];
        else if (mainCat === "MISC") subOptions = ["Other Research", "Helpful Documents"];

        const subOptionsHtml = subOptions.map(opt => {
            const sel = subCat === opt ? "selected" : "";
            return `<option value="${opt}" ${sel}>${opt}</option>`;
        }).join('');

        return `
            <tr class="hover:bg-slate-50/80 transition-colors" id="row-${item.id}">
                <td class="py-3 px-4 text-center border-b">
                    <input type="checkbox" value="${item.id}" onchange="onBulkCheckboxChange()" class="bulk-row-cb rounded border-slate-300 text-orange-500 focus:ring-orange-500 w-4 h-4 cursor-pointer">
                </td>
                <td class="py-3 px-4 border-b">
                    <select onchange="updateCellCategory('${item.id}', this.value)" class="text-xs border border-slate-200 rounded p-1 w-full bg-white focus:outline-none focus:ring-1 focus:ring-orange-500 font-medium text-slate-700">
                        <option value="MAZE" ${mazeSelected}>MAZE</option>
                        <option value="LAA" ${laaSelected}>LAA</option>
                        <option value="Device Resources" ${devSelected}>Device Resources</option>
                        <option value="MISC" ${miscSelected}>MISC</option>
                    </select>
                </td>
                <td class="py-3 px-4 border-b">
                    <select onchange="updateCellSubCategory('${item.id}', this.value)" class="text-xs border border-slate-200 rounded p-1 w-full bg-white focus:outline-none focus:ring-1 focus:ring-orange-500 font-medium text-slate-700">
                        ${subOptionsHtml}
                    </select>
                </td>
                <td contenteditable="true" onblur="updateCell('${item.id}', 'title', this.innerText)" class="py-3 px-4 text-xs font-semibold text-slate-800 border-b focus:bg-white outline-none cursor-text">${window.escapeHtml(item.title)}</td>
                <td contenteditable="true" onblur="updateCell('${item.id}', 'author', this.innerText)" class="py-3 px-4 text-xs text-slate-600 border-b focus:bg-white outline-none cursor-text">${window.escapeHtml(item.author)}</td>
                <td class="py-3 px-4 text-center border-b">
                    <button onclick="triggerDeleteConfirmModal('${item.id}')" class="p-1.5 text-slate-400 hover:text-red-600 transition-colors cursor-pointer" title="Delete Row"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                </td>
            </tr>`;
    }).join('');
    lucide.createIcons();
    window.onBulkCheckboxChange();
};

window.onBulkCheckboxChange = function() {
    const selected = document.querySelectorAll(".bulk-row-cb:checked");
    const countLabel = document.getElementById("bulkSelectedCount");
    if (countLabel) { countLabel.innerText = `${selected.length} Selected`; }
};

window.selectAllRows = function(check) {
    document.querySelectorAll(".bulk-row-cb").forEach(cb => cb.checked = check);
    window.onBulkCheckboxChange();
};

window.updateCell = async function(id, field, value) {
    const cleanVal = value.trim();
    const item = window.clinicalDatabase.find(d => d.id === id);
    if (!item) return;
    if (item[field] === cleanVal) return; 

    item[field] = cleanVal;
    try {
        if (window.isFirebaseActive && db) {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', id);
            await updateDoc(docRef, { [field]: cleanVal, lastModifiedTimestamp: Date.now() });
        } else {
            localStorage.setItem("atricure_local_resources", JSON.stringify(window.clinicalDatabase));
        }
        window.showToast("Field updated successfully.", "success");
        window.updateSidebarActiveStates();
    } catch (err) {
        console.error("Cell sync error:", err);
        window.showToast("Failed to sync cell changes.", "warning");
    }
};

window.updateCellCategory = async function(id, value) {
    const item = window.clinicalDatabase.find(d => d.id === id);
    if (!item) return;
    
    let subDefault = "Rhythm Outcomes";
    if (value === "LAA") subDefault = "Outcomes and Safety";
    else if (value === "Device Resources") subDefault = "IFUs";
    else if (value === "MISC") subDefault = "Other Research";

    item.mainCategory = value;
    item.subCategory = subDefault;

    try {
        if (window.isFirebaseActive && db) {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', id);
            await updateDoc(docRef, { mainCategory: value, subCategory: subDefault, lastModifiedTimestamp: Date.now() });
        } else {
            localStorage.setItem("atricure_local_resources", JSON.stringify(window.clinicalDatabase));
        }
        window.showToast("Category moved successfully.", "success");
        window.updateSidebarActiveStates();
        window.renderSpreadsheetWorkspace();
    } catch (err) {
        console.error("Category sync error:", err);
        window.showToast("Failed to move category.", "warning");
    }
};

window.updateCellSubCategory = async function(id, value) {
    const item = window.clinicalDatabase.find(d => d.id === id);
    if (!item) return;

    item.subCategory = value;
    try {
        if (window.isFirebaseActive && db) {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', id);
            await updateDoc(docRef, { subCategory: value, lastModifiedTimestamp: Date.now() });
        } else {
            localStorage.setItem("atricure_local_resources", JSON.stringify(window.clinicalDatabase));
        }
        window.showToast("Subcategory updated successfully.", "success");
        window.updateSidebarActiveStates();
    } catch (err) {
        console.error("Subcategory sync error:", err);
        window.showToast("Failed to save subcategory.", "warning");
    }
};

window.executeBulkMove = async function() {
    const selected = Array.from(document.querySelectorAll(".bulk-row-cb:checked")).map(cb => cb.value);
    if (selected.length === 0) {
        window.showToast("Please select at least one study to move.", "warning");
        return;
    }

    const moveTarget = document.getElementById("bulkCategoryMoveSelect").value;
    const [mainCat, subCat] = moveTarget.split(":");

    try {
        for (const id of selected) {
            const item = window.clinicalDatabase.find(d => d.id === id);
            if (item) {
                item.mainCategory = mainCat;
                item.subCategory = subCat;
                if (window.isFirebaseActive && db) {
                    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', id);
                    await updateDoc(docRef, { mainCategory: mainCat, subCategory: subCat, lastModifiedTimestamp: Date.now() });
                }
            }
        }
        if (!window.isFirebaseActive) localStorage.setItem("atricure_local_resources", JSON.stringify(window.clinicalDatabase));
        window.showToast(`Successfully moved ${selected.length} items to ${mainCat} > ${subCat}`, "success");
        window.updateSidebarActiveStates();
        window.renderSpreadsheetWorkspace();
    } catch (err) {
        console.error("Bulk move error:", err);
        window.showToast("Failed to complete bulk move.", "warning");
    }
};

window.executeBulkDelete = async function() {
    const selected = Array.from(document.querySelectorAll(".bulk-row-cb:checked")).map(cb => cb.value);
    if (selected.length === 0) {
        window.showToast("Please select at least one item to delete.", "warning");
        return;
    }

    if (!confirm(`Are you absolutely sure you want to PERMANENTLY delete ${selected.length} selected items from Firestore?`)) {
        return;
    }

    try {
        for (const id of selected) {
            if (window.isFirebaseActive && db) {
                const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', id);
                await deleteDoc(docRef);
            } else {
                const idx = window.clinicalDatabase.findIndex(d => d.id === id);
                if (idx !== -1) window.clinicalDatabase.splice(idx, 1);
            }
        }
        if (!window.isFirebaseActive) {
            localStorage.setItem("atricure_local_resources", JSON.stringify(window.clinicalDatabase));
            window.updateSidebarActiveStates();
            window.renderSpreadsheetWorkspace();
        }
        window.showToast(`Purged ${selected.length} entries successfully.`, "info");
    } catch (err) {
        console.error("Bulk delete error:", err);
        window.showToast("Failed to delete selection.", "warning");
    }
};

window.executeBulkMerge = async function() {
    const selected = Array.from(document.querySelectorAll(".bulk-row-cb:checked")).map(cb => cb.value);
    if (selected.length < 2) {
        window.showToast("Select at least 2 duplicates to merge them into a single record.", "warning");
        return;
    }

    if (!confirm(`This will merge ${selected.length} records into one master study. The other duplicate records will be permanently removed. Continue?`)) {
        return;
    }

    try {
        const masterId = selected[0];
        const duplicates = selected.slice(1);
        const masterItem = window.clinicalDatabase.find(d => d.id === masterId);

        if (!masterItem) return;

        let consolidatedSummary = masterItem.summary || "";
        let consolidatedUrls = [masterItem.url].filter(Boolean);

        for (const id of duplicates) {
            const dupItem = window.clinicalDatabase.find(d => d.id === id);
            if (dupItem) {
                const dupPoints = (dupItem.summary || "").split('\n').filter(p => p.trim());
                dupPoints.forEach(pt => {
                    if (!consolidatedSummary.includes(pt)) {
                        consolidatedSummary += "\n" + pt;
                    }
                });
                if (dupItem.url && !consolidatedUrls.includes(dupItem.url)) {
                    consolidatedUrls.push(dupItem.url);
                }
                
                if (window.isFirebaseActive && db) {
                  const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', id);
                  await deleteDoc(docRef);
                } else {
                  const idx = window.clinicalDatabase.findIndex(d => d.id === id);
                  if (idx !== -1) window.clinicalDatabase.splice(idx, 1);
                }
            }
        }

        masterItem.summary = consolidatedSummary;
        if (consolidatedUrls.length > 0) {
            masterItem.url = consolidatedUrls[0];
        }

        if (window.isFirebaseActive && db) {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'clinicalResources', masterId);
            await updateDoc(docRef, { summary: consolidatedSummary, url: masterItem.url, lastModifiedTimestamp: Date.now() });
        } else {
            localStorage.setItem("atricure_local_resources", JSON.stringify(window.clinicalDatabase));
        }

        window.showToast(`Merged ${selected.length} records into consolidated Master Study!`, "success");
        window.updateSidebarActiveStates();
        window.renderSpreadsheetWorkspace();
    } catch (err) {
        console.error("Merge failure:", err);
        window.showToast("Failed to complete duplicate merge.", "warning");
    }
};

// 🚀 DYNAMIC GENERATIVE QR MATRIX GENERATOR MODAL LOADER HOOKS
window.generateQrCodePopstream = function(url, title) {
    const canvasContainer = document.getElementById("qrCodeCanvasTarget");
    const modalTitle = document.getElementById("qrModalTitle");
    
    // Clear out any previous matrix drawings inside the canvas target
    canvasContainer.innerHTML = "";
    modalTitle.innerText = title;

    // Fire rendering stream payload onto target viewport wrapper elements
    new QRCode(canvasContainer, {
        text: url,
        width: 180,
        height: 180,
        colorDark: "#00205B", // AtriGuide deep navy theme code
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });

    document.getElementById("qrCodeDisplayModal").classList.remove("hidden");
    lucide.createIcons();
};

window.closeQrCodeModal = function() {
    document.getElementById("qrCodeDisplayModal").classList.add("hidden");
};

// =========================================================================
// 🚀 DYNAMIC SYSTEM BROADCAST TIMELINE AND ADMINISTRATION CONTROLLER CORE
// =========================================================================
window.activeBroadcastLogs = [];
window.isBroadcastExpanded = false;

window.toggleBroadcastAccordion = function() {
    window.isBroadcastExpanded = !window.isBroadcastExpanded;
    window.renderLiveBroadcastTimeline();
};

// Interface Paint Routine: Home Accordion Container Box
window.renderLiveBroadcastTimeline = function() {
    const target = document.getElementById("dynamicSystemBroadcastWrapper");
    if (!target) return;

    const items = window.activeBroadcastLogs || [];
    if (items.length === 0) {
        target.innerHTML = `
            <div class="bg-slate-100 border border-slate-200 rounded-xl p-4 text-center text-slate-500 text-xs font-semibold select-none">
                📢 AtriGuide Cloud Registry Active: Multi-file core modular framework successfully mapped.
            </div>`;
        return;
    }

    const latestBuild = items[0];
    const visibleLogs = items.slice(0, 3); // Restrict window to immediate top 3 records

    const timelineHtml = visibleLogs.map((log, idx) => `
        <div class="border-l-2 ${idx === 0 ? 'border-orange-500 bg-orange-50/10' : 'border-slate-200'} pl-4 ml-2 py-2.5 text-left">
            <div class="flex items-center space-x-2 mb-1.5 flex-wrap gap-y-1">
                <span class="font-mono text-[9px] font-black uppercase tracking-wider bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded shadow-sm">${window.escapeHtml(log.version)}</span>
                <h5 class="font-bold text-slate-800 text-xs tracking-tight">${window.escapeHtml(log.title)}</h5>
            </div>
            <p class="text-[11px] text-slate-600 leading-relaxed font-medium whitespace-pre-line">${window.escapeHtml(log.message)}</p>
        </div>
    `).join('<div class="h-2.5"></div>');

    target.innerHTML = `
        <div class="bg-slate-100 border border-slate-200 rounded-xl p-4 shadow-sm relative overflow-hidden">
            <div class="absolute right-0 top-0 translate-x-3 -translate-y-3 opacity-[0.03] text-slate-900 pointer-events-none select-none">
                <i data-lucide="megaphone" class="w-24 h-24"></i>
            </div>
            <div onclick="window.toggleBroadcastAccordion()" class="flex items-center justify-between cursor-pointer group select-none relative z-10">
                <div class="flex items-center space-x-3 min-w-0 flex-1 pr-2">
                    <div class="p-2 bg-amber-100 text-amber-600 rounded-lg shrink-0 group-hover:bg-orange-500 group-hover:text-white transition-colors duration-200">
                        <i data-lucide="megaphone" class="w-4 h-4 ${!window.isBroadcastExpanded ? 'animate-bounce' : ''}"></i>
                    </div>
                    <div class="min-w-0 flex-1 text-left">
                        <h4 class="font-bold text-slate-800 text-xs leading-none">
                            ${window.isBroadcastExpanded ? "What's New & System Logs" : "📢 Click to see what's new!"}
                        </h4>
                        <p class="text-[10px] text-slate-400 font-bold mt-1 uppercase tracking-wider font-mono truncate">
                            Latest: ${window.escapeHtml(latestBuild.version)} — ${window.escapeHtml(latestBuild.title)}
                        </p>
                    </div>
                </div>
                <button class="p-1 text-slate-400 group-hover:text-[#00205B] transition-colors shrink-0">
                    <i data-lucide="${window.isBroadcastExpanded ? 'chevron-up' : 'chevron-down'}" class="w-4 h-4"></i>
                </button>
            </div>

            <div class="${window.isBroadcastExpanded ? 'block mt-4 pt-4 border-t border-slate-200/60 animate-fade-in' : 'hidden'} relative z-10">
                <div class="max-h-[220px] overflow-y-auto pr-1.5 space-y-2 text-slate-700 scrollbar-thin">
                    ${timelineHtml}
                </div>
                <div class="border-t border-slate-200/50 mt-3 pt-2.5 flex justify-end">
                    <button onclick="window.routeToFullSystemChangelogHistory()" class="inline-flex items-center space-x-1 text-[10px] font-bold text-orange-500 hover:text-[#00205B] transition-colors cursor-pointer uppercase tracking-wider">
                        <span>View All Previous Updates</span>
                        <i data-lucide="arrow-right" class="w-3 h-3"></i>
                    </button>
                </div>
            </div>
        </div>`;
    lucide.createIcons();
};

// Router Intercept: Render Full Historical Archives Timeline Sheet
window.routeToFullSystemChangelogHistory = function() {
    window.currentMainCategory = null;
    window.currentSubCategory = null;
    window.isStarredFilterActive = false;
    
    document.querySelectorAll(".subcat-btn").forEach(btn => btn.classList.remove("bg-slate-100", "text-[#00205B]", "font-bold"));
    document.getElementById("categorySearchContainer").classList.add("hidden");

    const container = document.getElementById("userDashboardView");
    const bannerWrapper = document.getElementById("dynamicSystemBroadcastWrapper");
    if (!container) return;
    
    if (bannerWrapper) bannerWrapper.classList.add("hidden");

    const items = window.activeBroadcastLogs || [];
    const historyCardsHtml = items.map(log => `
        <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-2 text-left">
            <div class="flex items-center space-x-3 border-b border-slate-100 pb-2 flex-wrap gap-y-1">
                <span class="font-mono text-xs font-black uppercase tracking-wider bg-[#00205B] text-white px-2 py-0.5 rounded shadow-sm">${window.escapeHtml(log.version)}</span>
                <h4 class="font-bold text-slate-800 text-sm tracking-tight leading-snug">${window.escapeHtml(log.title)}</h4>
            </div>
            <p class="text-xs text-slate-600 leading-relaxed font-medium whitespace-pre-line pt-1">${window.escapeHtml(log.message)}</p>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="space-y-6 animate-fade-in pb-12 max-w-2xl mx-auto">
            <div class="flex items-center justify-between border-b border-slate-200 pb-4">
                <div class="flex items-center space-x-3">
                    <button onclick="window.navigateToHome()" class="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-500 transition-colors cursor-pointer flex items-center justify-center">
                        <i data-lucide="arrow-left" class="w-4 h-4"></i>
                    </button>
                    <div class="text-left">
                        <h2 class="text-lg font-black tracking-tight text-slate-800">System Build Archives</h2>
                        <p class="text-xs text-slate-400 font-semibold">Changelog ledger configuration history metrics</p>
                    </div>
                </div>
            </div>
            <div class="space-y-4">
                ${items.length === 0 ? '<p class="text-center text-slate-400 text-xs py-12">No historical registers loaded.</p>' : historyCardsHtml}
            </div>
        </div>`;
    document.getElementById("breadcrumbMain").innerText = "System History";
    document.getElementById("breadcrumbSub").innerText = "Changelog Registry";
    lucide.createIcons();
};

// Admin UI Broadcast Management Feed Sync Routine
window.renderAdminBroadcastInventory = function() {
    const target = document.getElementById("adminBroadcastInventoryTarget");
    if (!target) return;

    const items = window.activeBroadcastLogs || [];
    if (items.length === 0) {
        target.innerHTML = `<p class="text-center text-slate-400 text-xs py-10 font-medium">Broadcast ledger stream arrays empty.</p>`;
        return;
    }

    target.innerHTML = items.map(log => `
        <div class="bg-white border border-slate-200 p-3 rounded-lg shadow-sm flex items-start justify-between space-x-4 text-left">
            <div class="min-w-0 flex-1">
                <div class="flex items-center space-x-1.5 mb-1 flex-wrap">
                    <span class="font-mono text-[9px] font-bold bg-slate-100 border border-slate-200 px-1 py-0.2 rounded text-slate-600">${window.escapeHtml(log.version)}</span>
                    <h6 class="font-bold text-slate-800 text-xs truncate max-w-[240px]">${window.escapeHtml(log.title)}</h6>
                </div>
                <p class="text-[10px] text-slate-500 line-clamp-2 leading-relaxed font-medium">${window.escapeHtml(log.message)}</p>
            </div>
            <div class="flex items-center space-x-1 shrink-0">
                <button onclick="window.setupBroadcastEditWorkflow('${log.id}')" class="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors cursor-pointer" title="Edit fields">
                    <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
                </button>
                <button onclick="window.purgeBroadcastLogEntry('${log.id}')" class="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer" title="Purge permanently">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
            </div>
        </div>
    `).join('');
    lucide.createIcons();
};

window.setupBroadcastEditWorkflow = function(docId) {
    const log = window.activeBroadcastLogs.find(l => l.id === docId);
    if (!log) return;

    document.getElementById("broadcastEditDocId").value = log.id;
    document.getElementById("broadcastVersion").value = log.version;
    document.getElementById("broadcastTitle").value = log.title;
    document.getElementById("broadcastMessage").value = log.message;

    document.getElementById("submitBroadcastBtnLabel").innerText = "Save Log Changes";
    document.getElementById("cancelBroadcastEditBtn").classList.remove("hidden");
    window.showToast("Log attributes pulled onto control deck inputs.", "info");
};

window.clearBroadcastFormLayout = function() {
    document.getElementById("broadcastEditDocId").value = "";
    document.getElementById("broadcastVersion").value = "";
    document.getElementById("broadcastTitle").value = "";
    document.getElementById("broadcastMessage").value = "";

    document.getElementById("submitBroadcastBtnLabel").innerText = "Transmit Update";
    document.getElementById("cancelBroadcastEditBtn").classList.add("hidden");
};

window.publishFieldBroadcast = async function() {
    const editDocId = document.getElementById("broadcastEditDocId").value.trim();
    const versionInput = document.getElementById("broadcastVersion");
    const titleInput = document.getElementById("broadcastTitle");
    const msgInput = document.getElementById("broadcastMessage");

    const payload = {
        version: versionInput.value.trim(),
        title: titleInput.value.trim(),
        message: msgInput.value.trim()
    };

    try {
        if (!window.isFirebaseActive || !window.db) {
            window.showToast("Database write stream offline.", "warning");
            return;
        }

        const { collection, doc, addDoc, updateDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        
        if (editDocId !== "") {
            const docRef = doc(window.db, 'artifacts', 'atricure-clinical-hub', 'public', 'data', 'systemAnnouncements', editDocId);
            await updateDoc(docRef, payload);
            window.showToast("Log entry configurations updated seamlessly!", "success");
        } else {
            payload.timestamp = Date.now();
            const targetCollection = collection(window.db, 'artifacts', 'atricure-clinical-hub', 'public', 'data', 'systemAnnouncements');
            await addDoc(targetCollection, payload);
            window.showToast("New system announcement broadcasted live to field!", "success");
        }

        window.clearBroadcastFormLayout();
    } catch (err) {
        console.error("Broadcast write transmission failure trace:", err);
        window.showToast("Log write cycle failure.", "warning");
    }
};

window.purgeBroadcastLogEntry = async function(docId) {
    if (!confirm("Are you certain you want to purge this build notice log file entry permanently from network systems?")) return;

    try {
        if (window.isFirebaseActive && window.db) {
            const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
            const docRef = doc(window.db, 'artifacts', 'atricure-clinical-hub', 'public', 'data', 'systemAnnouncements', docId);
            await deleteDoc(docRef);
            
            if (document.getElementById("broadcastEditDocId").value === docId) {
                window.clearBroadcastFormLayout();
            }
            window.showToast("Build register record removed from server arrays.", "success");
        }
    } catch (err) {
        console.error("Purge routine execution trace crash:", err);
        window.showToast("Purge system call failed.", "warning");
    }
};

// 🔒 SECURE API KEY FIREBASE TRANSMISSION PATH
window.saveApiKeyToFirestore = async function() {
    const keyInput = document.getElementById("secureApiKeyInput");
    if (!keyInput || !window.db) return;
    const rawKey = keyInput.value.trim();
    try {
        const docRef = doc(window.db, 'artifacts', 'atricure-clinical-hub', 'public', 'data', 'config', 'gemini');
        await setDoc(docRef, { key: rawKey, lastModifiedTimestamp: Date.now() }, { merge: true });
        window.apiKey = rawKey;
        window.updateApiKeyStatusUI(true);
        window.showToast("API Key synced to artifacts path!", "success");
    } catch (err) { window.showToast("Failed to write.", "warning"); }
};

// 🚀 ENGINE BOOT SEQUENCE LIFECYCLE
const initApp = async () => {
    window.loadStarredCache();
    await window.attemptInitializeFirebase();
    window.updateSidebarActiveStates();
    window.renderAppViewboard();
    window.setupLocalEventListeners();
    lucide.createIcons();
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}
