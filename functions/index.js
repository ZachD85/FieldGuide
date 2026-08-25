"use strict";

const crypto = require("crypto");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {GoogleGenAI} = require("@google/genai");
const {GoogleAuth} = require("google-auth-library");

initializeApp();
const db = getFirestore();
const region = "us-central1";
const allowedOrigins = [
  "https://atriguide.net",
  "https://www.atriguide.net",
  "https://zachd85.github.io",
  /^http:\/\/(localhost|127\.0\.0\.1):8765$/,
];
const adminEmailHash = "57fc3c90f11335058e03af076dc4460ee4fa25a55550f2052ae250bf45ec56a6";

function requireSignedIn(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign-in is required.");
  return request.auth;
}

function requireAdmin(request) {
  const auth = requireSignedIn(request);
  if (auth.token.admin !== true) throw new HttpsError("permission-denied", "Admin access is required.");
  return auth;
}

function validateReviewCandidate(value) {
  if (!value || typeof value !== "object") throw new HttpsError("invalid-argument", "The review card is missing.");
  const candidate = JSON.parse(JSON.stringify(value));
  const allowedCategories = {
    MAZE: ["Rhythm Outcomes", "Survival Benefits", "Other"],
    LAA: ["Outcomes and Safety", "Stroke Reduction", "Prophylactic Data"],
    "Device Resources": ["IFUs", "Product Brochures", "Other Media"],
    MISC: ["Other Research", "Helpful Documents"],
  };
  const website = candidate.website || {};
  if (!candidate.id || !candidate.title || !candidate.summary || !Array.isArray(candidate.evidence) || !candidate.evidence.length) {
    throw new HttpsError("failed-precondition", "Title, summary, and verified evidence are required before approval.");
  }
  if (!allowedCategories[website.mainCategory]?.includes(website.subCategory)) {
    throw new HttpsError("invalid-argument", "Choose a valid website category.");
  }
  candidate.title = String(candidate.title).trim().slice(0, 300);
  candidate.summary = String(candidate.summary).trim().slice(0, 2000);
  candidate.citation = String(candidate.citation || "").trim().slice(0, 700);
  candidate.cardBullets = (candidate.cardBullets || []).map((x) => String(x).trim().slice(0, 500)).filter(Boolean).slice(0, 5);
  candidate.clinicalTags = (candidate.clinicalTags || []).map((x) => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 12);
  candidate.searchTerms = (candidate.searchTerms || []).map((x) => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 12);
  candidate.website = {...website, manualOverride: true};
  candidate.mainCategory = website.mainCategory;
  candidate.subCategory = website.subCategory;
  candidate.manualOverride = true;
  return candidate;
}

async function driveRequest(fileId, method = "GET", query = {}, body = null) {
  const auth = new GoogleAuth({scopes: ["https://www.googleapis.com/auth/drive"]});
  const client = await auth.getClient();
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  });
  const headers = await client.getRequestHeaders(url.toString());
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {method, headers, body: body ? JSON.stringify(body) : undefined});
  if (!response.ok) throw new Error(`Drive API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function enforceRateLimit(uid) {
  const ref = db.collection("_serverRateLimits").doc(uid);
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : {};
    const windowStart = Number(current.windowStart || 0);
    const count = now - windowStart < 60000 ? Number(current.count || 0) : 0;
    if (count >= 20) {
      throw new HttpsError("resource-exhausted", "Please wait before asking another question.");
    }
    transaction.set(ref, {
      windowStart: count === 0 ? now : windowStart,
      count: count + 1,
      updatedAt: now,
    });
  });
}

function cleanCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    const evidence = Array.isArray(item.evidence) ? item.evidence.slice(0, 4).map((claim) => ({
      claim: String(claim?.claim || "").slice(0, 500),
      page: Number.isInteger(claim?.page) && claim.page > 0 ? claim.page : null,
      locator: String(claim?.locator || "").slice(0, 80),
      kind: String(claim?.kind || "").slice(0, 40),
      excerpt: String(claim?.excerpt || "").slice(0, 240),
    })).filter((claim) => claim.claim) : [];
    return {
      id: String(item.id || "").slice(0, 80),
      title: String(item.title || "").slice(0, 300),
      author: String(item.author || "").slice(0, 300),
      documentType: String(item.documentType || "").slice(0, 40),
      category: String(item.category || "").slice(0, 120),
      summary: String(item.summary || "").slice(0, 1100),
      keywords: String(item.keywords || "").slice(0, 400),
      evidence,
    };
  }).filter((item) => item.id && item.title);
}

function cleanHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-6).map((turn) => ({
    role: turn?.role === "assistant" ? "assistant" : "user",
    text: String(turn?.text || "").slice(0, turn?.role === "assistant" ? 1800 : 500),
  })).filter((turn) => turn.text);
}

exports.askAtriGuide = onCall({
  region,
  cors: allowedOrigins,
  timeoutSeconds: 60,
  memory: "256MiB",
  maxInstances: 10,
}, async (request) => {
  const auth = requireSignedIn(request);
  await enforceRateLimit(auth.uid);
  const query = String(request.data?.query || "").trim().slice(0, 500);
  const deviceIntent = /\b(ifu|instructions? for use|operator'?s? manual|user manual|troubleshoot(?:ing)?|error code|fault code|how (?:do i|to)|change (?:the )?(?:default|setting)|setup|set up|operate|operation|program(?:ming)?|warning|precaution|contraindication|acm|asu|asb)\b/i.test(query);
  const candidates = cleanCandidates(request.data?.candidates).filter((candidate) =>
    deviceIntent || (!['ifu', 'brochure_other'].includes(candidate.documentType.toLowerCase()) &&
      !candidate.category.toLowerCase().startsWith('device resources')));
  const history = cleanHistory(request.data?.history);
  if (!query) throw new HttpsError("invalid-argument", "A question is required.");
  if (!candidates.length) return {synthesis: "No matching evidence cards were found.", matchedIds: []};

  const catalog = JSON.stringify(candidates);
  if (catalog.length > 48000) throw new HttpsError("invalid-argument", "Evidence context is too large.");
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCLOUD_PROJECT,
    location: "us-central1",
  });
  const prompt = `You are AtriGuide, an evidence-grounded clinical evidence assistant. ` +
    `Use only the supplied public evidence cards for factual claims. Conversation history provides intent only; ` +
    `it is not evidence. If the cards do not support an answer, say so clearly. Do not invent claims or IDs. ` +
    `Recognize practical clinical scenarios, time pressure, objections, and the answer format the user needs. ` +
    `Answer in one compact paragraph of roughly 3-5 sentences. Lead with the direct answer, then immediately give ` +
    `the strongest available numerical proof: exact patient population, sample size when available, treatment versus ` +
    `comparison results, absolute percentages, hazard or odds ratios with confidence intervals or p-values, and ` +
    `follow-up duration. Prefer numbers over adjectives and never replace an available number with vague wording such ` +
    `as "better outcomes." State plainly when the supplied cards do not contain the requested numerical proof. ` +
    `Do not add an introduction, restate the question, explain your process, or repeat the same fact. Put any ` +
    `material limitation into one short final clause in the same paragraph; do not create a separate context section. ` +
    `Return an empty talkingPoints array and empty caveat because all useful content belongs in the synthesis. ` +
    `For requests such as a 30-second discussion, return answerMode quick_pitch. For ordinary questions ` +
    `use answerMode standard. If a missing distinction would materially change the evidence, use clarification ` +
    `and state what must be clarified. Never present catheter-ablation evidence as proof for surgical ablation, ` +
    `or vice versa; label indirect evidence plainly. Never generalize a narrow population (for example, ` +
    `tachycardia-induced cardiomyopathy) to all patients with a similar feature (for example, low EF). ` +
    `When the concern is that a patient is too sick or high risk, include any supplied perioperative mortality, ` +
    `major complication, and study-design limitations alongside benefits. The caveat must identify material ` +
    `population mismatch, retrospective design, small sample size, and harms when those appear in the cards. ` +
    `Use cautious association language for observational evidence, not causal promises. ` +
    `Apply that same caution to the headline and synthesis: do not say an intervention is proven safe, improves ` +
    `survival, or applies to all low-EF patients unless the supplied evidence directly establishes that claim. ` +
    `Prefer wording such as "supports considering" or "was associated with" and name the studied population. ` +
    `For every central point, include a source mapping using only a supplied card ID and the zero-based ` +
    `evidenceIndex of the supplied evidence claim that supports it. Never invent a page or locator. If a card ` +
    `has no suitable evidence claim, omit that source mapping. Use each card ID at most once; select its strongest ` +
    `supporting evidence claim rather than repeating the same paper. Return exactly two short follow-up questions ` +
    `that can be answered from the cards.\n` +
    `Conversation history: ${JSON.stringify(history)}\nCurrent question: ${query}\nEvidence cards: ${catalog}`;
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      temperature: 0.1,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      thinkingConfig: {thinkingBudget: 0},
      responseJsonSchema: {
        type: "object",
        properties: {
          answerMode: {type: "string", enum: ["quick_pitch", "standard", "clarification"]},
          headline: {type: "string"},
          synthesis: {type: "string"},
          talkingPoints: {type: "array", items: {type: "string"}},
          caveat: {type: "string"},
          matchedIds: {type: "array", items: {type: "string"}},
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {id: {type: "string"}, evidenceIndex: {type: "integer"}, supports: {type: "string"}},
              required: ["id", "evidenceIndex", "supports"],
              additionalProperties: false,
            },
          },
          suggestedFollowUps: {type: "array", items: {type: "string"}},
        },
        required: ["answerMode", "headline", "synthesis", "talkingPoints", "caveat", "matchedIds", "sources", "suggestedFollowUps"],
        additionalProperties: false,
      },
    },
  });
  const text = result.text || "";
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    console.error("AI response validation failure", {
      textLength: text.length,
      finishReason: result.candidates?.[0]?.finishReason || "unknown",
      usage: result.usageMetadata || null,
    });
    throw new HttpsError("internal", "The AI response could not be validated.");
  }
  const allowedIds = new Set(candidates.map((item) => item.id));
  const candidateById = new Map(candidates.map((item) => [item.id, item]));
  const suggestedFollowUps = Array.isArray(parsed.suggestedFollowUps) ?
    parsed.suggestedFollowUps.map((value) => String(value).trim().slice(0, 160)).filter(Boolean).slice(0, 2) : [];
  const safeFallbacks = [
    "Which evidence card most directly supports this answer?",
    "What additional details or limitations are available in these evidence cards?",
  ];
  for (const fallback of safeFallbacks) {
    if (suggestedFollowUps.length >= 2) break;
    if (!suggestedFollowUps.includes(fallback)) suggestedFollowUps.push(fallback);
  }
  return {
    answerMode: ["quick_pitch", "standard", "clarification"].includes(parsed.answerMode) ? parsed.answerMode : "standard",
    headline: String(parsed.headline || "Evidence summary").slice(0, 180),
    synthesis: String(parsed.synthesis || "").slice(0, 1200),
    talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints.map((value) => String(value).slice(0, 500)).slice(0, 3) : [],
    caveat: String(parsed.caveat || "").slice(0, 700),
    matchedIds: Array.isArray(parsed.matchedIds) ? parsed.matchedIds.filter((id) => allowedIds.has(id)).slice(0, 8) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources
      .filter((source) => allowedIds.has(source?.id))
      .filter((source, index, rows) => rows.findIndex((row) => row?.id === source?.id) === index)
      .map((source) => {
        const card = candidateById.get(source.id);
        const evidenceIndex = Number.isInteger(source.evidenceIndex) ? source.evidenceIndex : -1;
        const evidence = card?.evidence?.[evidenceIndex];
        if (!evidence) return null;
        return {
          id: source.id,
          evidenceIndex,
          supports: String(source.supports || evidence.claim).slice(0, 300),
          page: evidence.page,
          locator: evidence.locator,
          claim: evidence.claim,
        };
      })
      .filter(Boolean)
      .slice(0, 4) : [],
    suggestedFollowUps,
  };
});

exports.bootstrapAdmin = onCall({region, cors: allowedOrigins, maxInstances: 2}, async (request) => {
  const auth = requireSignedIn(request);
  const email = String(auth.token.email || "").trim().toLowerCase();
  const provider = String(auth.token.firebase?.sign_in_provider || "");
  const digest = crypto.createHash("sha256").update(email).digest("hex");
  if (provider !== "google.com" || auth.token.email_verified !== true || digest !== adminEmailHash) {
    throw new HttpsError("permission-denied", "This Google account is not authorized for Admin access.");
  }
  const user = await getAuth().getUser(auth.uid);
  await getAuth().setCustomUserClaims(auth.uid, {...(user.customClaims || {}), admin: true});
  return {admin: true};
});

exports.applyIngestionReview = onCall({
  region,
  cors: allowedOrigins,
  timeoutSeconds: 60,
  memory: "256MiB",
  maxInstances: 2,
  // This is the Drive-enabled service account used by the desktop importer.
  // The default Cloud Functions runtime account can read shared PDFs but
  // cannot move them between the Pending and Archive folders.
  serviceAccount: "firebase-adminsdk-fbsvc@atricure-app.iam.gserviceaccount.com",
}, async (request) => {
  requireAdmin(request);
  const queueId = String(request.data?.queueId || "").trim();
  const decision = String(request.data?.decision || "");
  if (!queueId || !["approved", "duplicate_confirmed"].includes(decision)) {
    throw new HttpsError("invalid-argument", "A valid review decision is required.");
  }
  const queueRef = db.doc(`artifacts/atricure-clinical-hub/public/data/ingestionReviewQueue/${queueId}`);
  const snapshot = await queueRef.get();
  if (!snapshot.exists) throw new HttpsError("not-found", "This review item no longer exists.");
  const item = snapshot.data() || {};
  const fileId = String(item.fileId || "");
  if (!fileId) throw new HttpsError("failed-precondition", "The source PDF is missing its Drive ID.");

  let candidate = null;
  if (decision === "approved") {
    candidate = validateReviewCandidate(request.data?.candidate || item.candidate);
    if (!item.candidate?.id || candidate.id !== item.candidate.id) {
      throw new HttpsError("invalid-argument", "The approved card does not match this review item.");
    }
    if (candidate.source?.driveFileId && candidate.source.driveFileId !== fileId) {
      throw new HttpsError("invalid-argument", "The approved card does not match its source PDF.");
    }
    const clean = Object.fromEntries(Object.entries(candidate).filter(([key]) => !key.startsWith("_") && key !== "id"));
    clean.ingestion = {...(clean.ingestion || {}), publishedAt: Date.now(), approvedFromReview: true};
    await db.doc(`artifacts/atricure-clinical-hub/public/data/clinicalResources/${candidate.id}`).set(clean, {merge: true});
  }

  try {
    const file = await driveRequest(fileId, "GET", {fields: "id,name,parents,trashed", supportsAllDrives: true});
    if (decision === "duplicate_confirmed") {
      if (!file.trashed) await driveRequest(fileId, "PATCH", {fields: "id,trashed", supportsAllDrives: true}, {trashed: true});
    } else {
      const parents = file.parents || [];
      await driveRequest(fileId, "PATCH", {
        addParents: "1wl-qyPmjlr9eBBUFhhvD8diVk9mJp8ZH",
        removeParents: parents.join(","),
        fields: "id,parents",
        supportsAllDrives: true,
      }, {});
    }
  } catch (error) {
    console.error("Drive finalization failed", {queueId, decision, message: error?.message});
    await queueRef.set({queueStatus: "apply_failed", applyError: "The database was updated, but the PDF could not be moved.", updatedAt: Date.now()}, {merge: true});
    throw new HttpsError("internal", "The card was saved, but the PDF could not be moved. It is safe to retry.");
  }

  const finalStatus = decision === "approved" ? "published_and_archived" : "duplicate_trashed";
  await queueRef.set({
    candidate: candidate || item.candidate || null,
    decision,
    decisionApplied: true,
    queueStatus: finalStatus,
    appliedAt: Date.now(),
    updatedAt: Date.now(),
  }, {merge: true});
  return {status: finalStatus};
});
