import Groq from "groq-sdk";
import dotenv from "dotenv";
import prisma from "../lib/prisma.js";

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ============================================
// SESSION MANAGEMENT
// ============================================

const conversationSessions = new Map();

const SESSION_CONFIG = {
  maxHistoryLength: 20,
  sessionTimeout: 30 * 60 * 1000,
  maxSessions: 1000
};

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of conversationSessions.entries()) {
    if (now - session.lastActivity > SESSION_CONFIG.sessionTimeout) {
      conversationSessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

const getSessionContext = (sessionId) => {
  if (!conversationSessions.has(sessionId)) {
    if (conversationSessions.size >= SESSION_CONFIG.maxSessions) {
      const oldestKey = conversationSessions.keys().next().value;
      conversationSessions.delete(oldestKey);
    }

    conversationSessions.set(sessionId, {
      history: [],         // full conversation history
      isFirstMessage: true, // used to greet exactly once
      // Best known search params — built up across messages
      collected: {
        location: null,      // e.g. "Ikeja"
        action: null,        // "buy" | "rent"
        propertyType: null,  // "house" | "apartment" | "land" | "commercial"
        bedrooms: null,      // number | null
        priceRange: null     // { min, max } | null
      },
      createdAt: Date.now(),
      lastActivity: Date.now()
    });
  }

  const session = conversationSessions.get(sessionId);
  session.lastActivity = Date.now();
  return session;
};

const updateSessionContext = (sessionId, updates) => {
  const session = conversationSessions.get(sessionId);
  if (session) {
    Object.assign(session, updates);
    if (session.history.length > SESSION_CONFIG.maxHistoryLength) {
      session.history = session.history.slice(-SESSION_CONFIG.maxHistoryLength);
    }
  }
};

// ============================================
// RETRY UTILITY
// ============================================

const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 1000) => {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
};

// ============================================
// BULK FIELD EXTRACTOR
// Pulls every search-relevant field from a single message in one LLM call.
// Returns only what was found — null for anything not mentioned.
// ============================================

const extractFields = async (message) => {
  const result = await retryWithBackoff(() =>
    groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You extract Nigerian real estate search parameters from natural language messages.
Return ONLY this JSON — null for anything not mentioned or unclear:
{
  "location": "Nigerian city or area | null",
  "action": "buy" | "rent" | null,
  "propertyType": "house" | "apartment" | "land" | "commercial" | null,
  "bedrooms": number | null,
  "priceRange": { "min": number, "max": number } | null,
  "isSearchIntent": true | false
}

LOCATION — Nigerian cities and areas:
Cities: Lagos, Abuja, Port Harcourt, Ibadan, Kano, Enugu, Benin City, Warri, Owerri, Uyo, Kaduna, Jos
Lagos areas: Lekki, Victoria Island, VI, Ikoyi, Ajah, Surulere, Yaba, Ikeja, Magodo, Gbagada, Ojodu, Ikorodu, Badagry, Sangotedo
Abuja areas: Maitama, Wuse, Asokoro, Gwarinpa, Jabi, Garki, Apo, Kubwa, Life Camp, Katampe
PH areas: GRA, Trans Amadi, Old GRA, Rumuola

PROPERTY TYPES:
- flat / mini flat / self-con / self contained / studio / condo → "apartment"
- house / duplex / bungalow / detached / semi-detached / terrace / mansion → "house"
- land / plot / plots → "land"
- office / shop / warehouse / commercial space → "commercial"

PRICE PARSING:
- "million" or "m" after a number = ×1,000,000
- "k" after a number = ×1,000
- "under X" / "below X" / "max X" → priceRange: { min: 0, max: X }
- "above X" / "from X" → priceRange: { min: X, max: null }
- "between X and Y" / "X to Y" → priceRange: { min: X, max: Y }
- If only one bound is mentioned, leave the other as null

isSearchIntent:
- true  → user wants to find/see/search properties (even if info is partial)
- false → user is greeting, asking advice, asking general questions, or just chatting

EXAMPLES:
"find me a 2 bedroom flat in Ikeja under 1 million"
→ { location:"Ikeja", action:null, propertyType:"apartment", bedrooms:2, priceRange:{min:0,max:1000000}, isSearchIntent:true }

"3 bed duplex in Maitama Abuja to buy, budget around 80 million"
→ { location:"Maitama", action:"buy", propertyType:"house", bedrooms:3, priceRange:{min:0,max:80000000}, isSearchIntent:true }

"i want to rent a house in lekki"
→ { location:"Lekki", action:"rent", propertyType:"house", bedrooms:null, priceRange:null, isSearchIntent:true }

"self con yaba"
→ { location:"Yaba", action:null, propertyType:"apartment", bedrooms:null, priceRange:null, isSearchIntent:true }

"houses in lekki"
→ { location:"Lekki", action:null, propertyType:"house", bedrooms:null, priceRange:null, isSearchIntent:true }

"what areas in lagos are affordable?"
→ { location:"Lagos", action:null, propertyType:null, bedrooms:null, priceRange:null, isSearchIntent:false }

"hello" / "hi" / "good morning"
→ { location:null, action:null, propertyType:null, bedrooms:null, priceRange:null, isSearchIntent:false }

"show me more" / "what else is available?"
→ { location:null, action:null, propertyType:null, bedrooms:null, priceRange:null, isSearchIntent:true }`
        },
        { role: "user", content: message }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      response_format: { type: "json_object" }
    })
    , 3, 500);

  try {
    const parsed = JSON.parse(result.choices[0]?.message?.content || '{}');
    return {
      location: parsed.location || null,
      action: parsed.action || null,
      propertyType: parsed.propertyType || null,
      bedrooms: parsed.bedrooms || null,
      priceRange: parsed.priceRange || null,
      isSearchIntent: parsed.isSearchIntent === true
    };
  } catch {
    return {
      location: null, action: null, propertyType: null,
      bedrooms: null, priceRange: null, isSearchIntent: false
    };
  }
};

// Merge newly extracted fields onto existing collected fields.
// Only overwrites null — never wipes a field the user already gave us.
const mergeFields = (existing, incoming) => ({
  location: incoming.location ?? existing.location,
  action: incoming.action ?? existing.action,
  propertyType: incoming.propertyType ?? existing.propertyType,
  bedrooms: incoming.bedrooms ?? existing.bedrooms,
  priceRange: incoming.priceRange ?? existing.priceRange
});

// Determine what required fields are still missing.
// Land and commercial don't need bedrooms.
const getMissingFields = (collected) => {
  const missing = [];
  if (!collected.location) missing.push('location');
  if (!collected.action) missing.push('action');
  if (!collected.propertyType) missing.push('propertyType');
  return missing;
};

// Build one natural follow-up question asking for all missing fields at once.
const buildFollowUpQuestion = (missing, collected) => {
  const questions = {
    location: "Which city or area in Nigeria are you looking at? (e.g. Lekki, Ikeja, Maitama)",
    action: "Are you looking to buy or rent?",
    propertyType: "What type of property — house, apartment, land, or commercial?",
    bedrooms: "How many bedrooms do you need?"
  };

  if (missing.length === 1) {
    return questions[missing[0]];
  }

  if (missing.length === 2) {
    return `${questions[missing[0]]} Also — ${questions[missing[1]].toLowerCase()}`;
  }

  // 3+ missing — ask the most important one first (location > action > type > bedrooms)
  return questions[missing[0]];
};

// ============================================
// DATABASE SEARCH
// ============================================

const searchListings = async (filters) => {
  const { location, propertyType, priceRange, bedrooms, action } = filters;

  try {
    await prisma.$connect();

    const where = { AND: [] };

    if (location) {
      where.AND.push({
        OR: [
          { city: { contains: location, mode: 'insensitive' } },
          { country: { contains: location, mode: 'insensitive' } },
          { address: { contains: location, mode: 'insensitive' } }
        ]
      });
    }

    if (propertyType && propertyType !== 'any') {
      where.AND.push({ property: propertyType });
    }

    if (priceRange) {
      const priceCondition = {};
      if (priceRange.min != null) priceCondition.gte = priceRange.min;
      if (priceRange.max != null) priceCondition.lte = priceRange.max;
      if (Object.keys(priceCondition).length > 0) {
        where.AND.push({ price: priceCondition });
      }
    }

    if (bedrooms) {
      where.AND.push({ bedroom: { gte: bedrooms } });
    }

    if (action && action !== 'any') {
      where.AND.push({ type: action });
    }

    const posts = await prisma.post.findMany({
      where: where.AND.length > 0 ? where : undefined,
      select: {
        id: true, title: true, city: true, country: true,
        price: true, bedroom: true, bathroom: true,
        property: true, type: true, images: true
      },
      take: 10
    });

    return { count: posts.length, posts };
  } catch (err) {
    console.error("Database query error:", err);
    return { count: 0, posts: [] };
  }
};

// ============================================
// RESPONSE GENERATOR
// The LLM writes the actual reply — but only after we've handled
// all flow logic above. It knows the full context and search results.
// ============================================

const generateResponse = async (message, context, searchResults, collected, isFirstMessage) => {
  const conversationHistory = context.history.map(m => ({
    role: m.role === 'model' ? 'assistant' : m.role,
    content: m.content
  }));

  const hasResults = searchResults.count > 0;
  const listingText = hasResults
    ? searchResults.posts.map((p, i) =>
      `${i + 1}. ${p.title} — ${p.city} | ${p.bedroom ?? '?'} bed, ${p.bathroom ?? '?'} bath | ${p.type === 'rent' ? 'For rent' : 'For sale'} | ₦${p.price?.toLocaleString() ?? 'N/A'}`
    ).join('\n')
    : 'No listings found for these filters.';

  const systemPrompt = `You are Runo, PrimeNest's AI property assistant for Nigeria. You are sharp, warm, and direct — like a knowledgeable friend in the Nigerian real estate market.

${isFirstMessage
      ? `This is the user's very first message. Greet them warmly but briefly (one short sentence), then respond to what they said.`
      : `This is NOT the first message. Do NOT greet. Do NOT say "Hi", "Hello", "Welcome", or introduce yourself. Just respond naturally.`
    }

ABSOLUTE RULES:
- Only use Naira (₦). Never dollars, pounds, or any other currency.
- Never ask for information that is already in "What we know about this user" below.
- Be concise — 2 to 4 sentences for most replies, more only for detailed advice.
- No filler phrases like "Great question!", "Certainly!", or "Of course!".

WHAT WE KNOW ABOUT THIS USER SO FAR:
- Location: ${collected.location ?? 'not told yet'}
- Looking to: ${collected.action ?? 'not told yet'}
- Property type: ${collected.propertyType ?? 'not told yet'}
- Bedrooms: ${collected.bedrooms ?? 'not told yet'}
- Budget: ${collected.priceRange ? `₦${collected.priceRange.min?.toLocaleString() ?? '0'} – ₦${collected.priceRange.max?.toLocaleString() ?? 'open'}` : 'not told yet'}

NIGERIAN MARKET KNOWLEDGE (use this to sound smart and give real advice):
- Lagos pricing: Self-con in Yaba/Surulere ₦200k–₦600k/yr. 2-bed in Lekki Phase 1 ₦1.5M–₦4M/yr rent. 3-bed for sale in Lekki/VI ₦80M–₦300M+.
- Abuja pricing: 2-bed in Gwarinpa ₦700k–₦1.5M/yr rent. 3-bed in Maitama/Asokoro for sale ₦100M–₦500M+.
- Port Harcourt: GRA 3-bed ₦1.5M–₦3M/yr rent.
- Lekki, VI, Ikoyi = premium Lagos. Surulere, Yaba, Ikeja = mid-range. Ikorodu, Badagry = affordable.
- Maitama, Asokoro = premium Abuja. Gwarinpa, Kubwa = mid-range Abuja.
- Island Lagos = convenient but pricey. Mainland Lagos = affordable but traffic.
- Always ask about service charge for estate properties. Always inspect before paying any fees.

SEARCH RESULTS:
${listingText}

HOW TO RESPOND:
- Search has results → lead with a quick confident summary, highlight 1-2 standout options, suggest a useful next step.
- No results → be honest, then suggest a smart nearby area or loosened filter based on your market knowledge.
- User asks advice or a general question → give specific, Nigeria-grounded insight. Skip the search results if they are not relevant.
- User is just chatting → respond naturally and helpfully.
- Always close with exactly ONE useful follow-up — a question, a suggestion, or a tip. Not two, not zero.

RESPOND ONLY with this JSON and nothing else:
{
  "reply": "your full response text",
  "searchUrl": "/list?city=...&property=...&type=...&bedroom=..." or null,
  "suggestions": ["short specific follow-up 1", "short specific follow-up 2"]
}`;

  try {
    const completion = await retryWithBackoff(() =>
      groq.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          ...conversationHistory,
          { role: "user", content: message }
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0.7,
        max_tokens: 800,
        response_format: { type: "json_object" }
      })
      , 2, 1000);

    const raw = completion.choices[0]?.message?.content || '{}';

    try {
      const data = JSON.parse(raw);

      // Always build the searchUrl from what we actually collected
      if (collected.location) {
        const params = new URLSearchParams();
        params.set('city', collected.location);
        if (collected.propertyType) params.set('property', collected.propertyType);
        if (collected.action) params.set('type', collected.action);
        if (collected.bedrooms) params.set('bedroom', String(collected.bedrooms));
        if (collected.priceRange?.min != null) params.set('minPrice', String(collected.priceRange.min));
        if (collected.priceRange?.max != null) params.set('maxPrice', String(collected.priceRange.max));
        data.searchUrl = `/list?${params.toString()}`;
      } else {
        data.searchUrl = null;
      }

      return data;
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error("Unparseable response");
    }
  } catch (err) {
    console.error("Response generation error:", err);
    return {
      reply: "Something went wrong on my end. Try rephrasing what you're looking for.",
      searchUrl: null,
      suggestions: ["Houses for rent in Lekki", "2 bedroom flat in Ikeja under ₦1M"]
    };
  }
};

// ============================================
// MAIN CHAT HANDLER
// ============================================

export const chatWithAssistant = async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ reply: "Please type a message.", searchUrl: null });
  }

  const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const context = getSessionContext(sid);
    const isFirst = context.isFirstMessage;
    context.isFirstMessage = false;

    // Add user message to history
    context.history.push({ role: 'user', content: message });

    // Step 1 — extract whatever fields we can from this message
    const extracted = await extractFields(message);

    // Step 2 — merge with anything we already know from earlier messages
    context.collected = mergeFields(context.collected, extracted);
    const collected = context.collected;

    let responseData;

    if (extracted.isSearchIntent) {
      // User wants to search — check what we still need
      const missing = getMissingFields(collected);

      if (missing.length === 0) {
        // We have everything — run the search
        const searchResults = await searchListings(collected);
        responseData = await generateResponse(message, context, searchResults, collected, isFirst);

      } else {
        // We're missing something — ask for it naturally, don't search yet
        const followUp = buildFollowUpQuestion(missing, collected);

        // If it's the first message, prepend a short greeting
        const reply = isFirst
          ? `Hi! I'm Runo, PrimeNest's property assistant. ${followUp}`
          : followUp;

        responseData = {
          reply,
          searchUrl: null,
          suggestions: buildSuggestions(missing, collected)
        };
      }

    } else {
      // Not a search intent — general conversation or advice
      // Still run a background search if we have enough to be useful
      const missing = getMissingFields(collected);
      const hasEnough = missing.length <= 1 && collected.location;
      const searchResults = hasEnough
        ? await searchListings(collected)
        : { count: 0, posts: [] };

      responseData = await generateResponse(message, context, searchResults, collected, isFirst);
    }

    // Save assistant reply to history
    context.history.push({ role: 'model', content: responseData.reply });
    updateSessionContext(sid, {});

    return res.status(200).json({ ...responseData, sessionId: sid });

  } catch (err) {
    console.error("Assistant Error:", err);
    return res.status(200).json({
      reply: "Something went wrong. Please try again.",
      searchUrl: null,
      sessionId: sid,
      suggestions: ["Houses for rent in Lekki", "2 bed flat in Abuja under ₦2M"]
    });
  }
};

// ============================================
// SUGGESTION BUILDER
// Gives the user sensible quick-reply chips based on what's missing.
// ============================================

const buildSuggestions = (missing, collected) => {
  if (missing.includes('location')) {
    return ["Lekki Lagos", "Ikeja Lagos", "Maitama Abuja", "GRA Port Harcourt"];
  }
  if (missing.includes('action')) {
    return ["Rent", "Buy"];
  }
  if (missing.includes('propertyType')) {
    return ["House", "Apartment", "Land", "Commercial"];
  }
  if (missing.includes('bedrooms')) {
    return ["1 bedroom", "2 bedrooms", "3 bedrooms", "4+ bedrooms"];
  }
  return [];
};

// ============================================
// SESSION MANAGEMENT ENDPOINTS
// ============================================

export const clearSession = async (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && conversationSessions.has(sessionId)) {
    conversationSessions.delete(sessionId);
  }
  res.status(200).json({ reply: "Session cleared.", sessionId: null });
};

export const getSessionInfo = async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || !conversationSessions.has(sessionId)) {
    return res.status(404).json({ error: "Session not found" });
  }
  const session = conversationSessions.get(sessionId);
  res.status(200).json({
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    messageCount: session.history.length,
    collected: session.collected
  });
};
