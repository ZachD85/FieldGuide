"use strict";

const crypto = require("crypto");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {GoogleGenAI} = require("@google/genai");

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
  return value.slice(0, 12).map((item) => {
    const evidence = Array.isArray(item.evidence) ? item.evidence.slice(0, 8).map((claim) => ({
      claim: String(claim?.claim || "").slice(0, 700),
      page: Number.isInteger(claim?.page) && claim.page > 0 ? claim.page : null,
      locator: String(claim?.locator || "").slice(0, 80),
      kind: String(claim?.kind || "").slice(0, 40),
      excerpt: String(claim?.excerpt || "").slice(0, 500),
    })).filter((claim) => claim.claim) : [];
    return {
      id: String(item.id || "").slice(0, 80),
      title: String(item.title || "").slice(0, 300),
      author: String(item.author || "").slice(0, 300),
      category: String(item.category || "").slice(0, 120),
      summary: String(item.summary || "").slice(0, 1400),
      keywords: String(item.keywords || "").slice(0, 600),
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
  const candidates = cleanCandidates(request.data?.candidates);
  const history = cleanHistory(request.data?.history);
  if (!query) throw new HttpsError("invalid-argument", "A question is required.");
  if (!candidates.length) return {synthesis: "No matching evidence cards were found.", matchedIds: []};

  const catalog = JSON.stringify(candidates);
  if (catalog.length > 24000) throw new HttpsError("invalid-argument", "Evidence context is too large.");
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCLOUD_PROJECT,
    location: "us-central1",
  });
  const prompt = `You are AtriGuide, an evidence-grounded clinical evidence assistant. ` +
    `Use only the supplied public evidence cards for factual claims. Conversation history provides intent only; ` +
    `it is not evidence. If the cards do not support an answer, say so clearly. Do not invent claims or IDs. ` +
    `Recognize practical clinical scenarios, time pressure, objections, and the answer format the user needs. ` +
    `For requests such as a 30-second discussion, return answerMode quick_pitch, a direct headline, a brief ` +
    `spoken-style synthesis, up to three supporting talkingPoints, and one honest caveat. For ordinary questions ` +
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
    `has no suitable evidence claim, omit that source mapping. Return exactly two short follow-up questions ` +
    `that can be answered from the cards.\n` +
    `Conversation history: ${JSON.stringify(history)}\nCurrent question: ${query}\nEvidence cards: ${catalog}`;
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      temperature: 0.1,
      maxOutputTokens: 1800,
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
    synthesis: String(parsed.synthesis || "").slice(0, 1800),
    talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints.map((value) => String(value).slice(0, 500)).slice(0, 3) : [],
    caveat: String(parsed.caveat || "").slice(0, 700),
    matchedIds: Array.isArray(parsed.matchedIds) ? parsed.matchedIds.filter((id) => allowedIds.has(id)).slice(0, 8) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources
      .filter((source) => allowedIds.has(source?.id))
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
      .slice(0, 6) : [],
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
