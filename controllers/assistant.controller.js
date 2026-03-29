import Groq from "groq-sdk";
import dotenv from "dotenv";
import prisma from "../lib/prisma.js";

dotenv.config();

// Using Groq exclusively - much more generous free tier (14M tokens/month)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ============================================
// CONVERSATION SESSION MANAGEMENT
// ============================================

// In-memory session storage (consider Redis for production)
const conversationSessions = new Map();

// Session configuration
const SESSION_CONFIG = {
  maxHistoryLength: 20,      // Keep last 20 messages for context
  sessionTimeout: 30 * 60 * 1000, // 30 minutes
  maxSessions: 1000          // Maximum concurrent sessions
};

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of conversationSessions.entries()) {
    if (now - session.lastActivity > SESSION_CONFIG.sessionTimeout) {
      conversationSessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// Get or create session context
const getSessionContext = (sessionId) => {
  if (!conversationSessions.has(sessionId)) {
    // Enforce session limit
    if (conversationSessions.size >= SESSION_CONFIG.maxSessions) {
      // Remove oldest session
      const oldestKey = conversationSessions.keys().next().value;
      conversationSessions.delete(oldestKey);
    }

    conversationSessions.set(sessionId, {
      history: [],
      lastIntent: null,
      lastLocation: null,
      preferences: {
        propertyType: null,
        priceRange: null,
        bedrooms: null,
        locations: []
      },
      createdAt: Date.now(),
      lastActivity: Date.now()
    });
  }

  const session = conversationSessions.get(sessionId);
  session.lastActivity = Date.now();
  return session;
};

// Update session context
const updateSessionContext = (sessionId, updates) => {
  const session = conversationSessions.get(sessionId);
  if (session) {
    Object.assign(session, updates);
    // Trim history if too long
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
        const delay = baseDelay * Math.pow(2, i);
        console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
};

// ============================================
// INTENT DETECTION WITH CONTEXT
// ============================================

const detectIntent = async (message, context) => {
  const contextHint = context.lastLocation
    ? `Previous location mentioned: ${context.lastLocation}`
    : '';

  const intentCompletion = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content: `You are analyzing real estate queries for a Nigerian property platform.

${contextHint}

Extract intent and key filters. Return ONLY this JSON (no extra text):
{
  "intent": "search|advice|greeting|follow_up|clarification",
  "location": "Nigerian city/area name or null",
  "propertyType": "apartment|house|duplex|bungalow|land|commercial|any",
  "priceRange": {"min": number, "max": number} or null,
  "bedrooms": number or null,
  "action": "buy|rent|any"
}

INTENT RULES:
- search: user wants to find/see properties
- advice: user wants tips, market info, or real estate guidance
- greeting: user is saying hello or starting fresh
- follow_up: user references previous results ("what about those?", "show more")
- clarification: user is narrowing/refining a previous search

NIGERIAN CONTEXT — recognize these locations and local terms:
- Cities: Lagos, Abuja, Port Harcourt, Ibadan, Kano, Enugu, Benin City, Warri, Owerri, Uyo, Kaduna, Jos
- Lagos zones: Lekki, Victoria Island (VI), Ikoyi, Ajah, Surulere, Yaba, Ikeja, Magodo, Ojodu, Ikorodu, Badagry, Sangotedo
- Abuja zones: Maitama, Wuse, Asokoro, Gwarinpa, Jabi, Garki, Apo, Kubwa, Life Camp, Katampe
- PH zones: GRA, Trans Amadi, Old GRA, Rumuola
- Nigerian property terms: "self-con" = studio/self-contained, "face-me-I-face-you" = shared compound, "mini flat" = 1-bed, "boys quarter" = BQ/servant quarters
- Price clues: "million" or "m" = x1,000,000 naira. "k" = x1,000 naira

Examples:
- "2 bedroom flat in Lekki for rent" → intent:search, location:Lekki, propertyType:apartment, bedrooms:2, action:rent
- "self con in Yaba under 500k" → intent:search, location:Yaba, propertyType:apartment, priceRange:{min:0,max:500000}, action:rent
- "houses in Maitama under 150 million" → intent:search, location:Maitama, propertyType:house, priceRange:{min:0,max:150000000}, action:buy
- "what about 3 bedrooms?" → intent:clarification, bedrooms:3
- "show me more" → intent:follow_up`
      },
      { role: "user", content: message }
    ],
    model: "llama-3.1-8b-instant",
    temperature: 0.1,
    response_format: { type: "json_object" }
  });

  try {
    const response = JSON.parse(intentCompletion.choices[0]?.message?.content || '{}');
    return {
      intent: response.intent || 'greeting',
      location: response.location || null,
      propertyType: response.propertyType || 'any',
      priceRange: response.priceRange || null,
      bedrooms: response.bedrooms || null,
      action: response.action || 'any'
    };
  } catch (e) {
    console.error("Intent parsing error:", e);
    return { intent: 'greeting', location: null };
  }
};

// ============================================
// DATABASE SEARCH
// ============================================

const searchListings = async (filters) => {
  const { location, propertyType, priceRange, bedrooms, action } = filters;

  try {
    await prisma.$connect();

    const where = { AND: [] };

    // Location filter
    if (location) {
      where.AND.push({
        OR: [
          { city: { contains: location, mode: 'insensitive' } },
          { country: { contains: location, mode: 'insensitive' } },
          { address: { contains: location, mode: 'insensitive' } }
        ]
      });
    }

    // Property type filter
    if (propertyType && propertyType !== 'any') {
      where.AND.push({ property: propertyType });
    }

    // Price range filter
    if (priceRange) {
      const priceCondition = {};
      if (priceRange.min) priceCondition.gte = priceRange.min;
      if (priceRange.max) priceCondition.lte = priceRange.max;
      if (Object.keys(priceCondition).length > 0) {
        where.AND.push({ price: priceCondition });
      }
    }

    // Bedrooms filter
    if (bedrooms) {
      where.AND.push({ bedroom: { gte: bedrooms } });
    }

    // Action (buy/rent) filter
    if (action && action !== 'any') {
      where.AND.push({ type: action });
    }

    const posts = await prisma.post.findMany({
      where: where.AND.length > 0 ? where : undefined,
      select: {
        id: true,
        title: true,
        city: true,
        country: true,
        price: true,
        bedroom: true,
        bathroom: true,
        property: true,
        type: true,
        images: true
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
// RESPONSE GENERATION (Using Groq)
// ============================================

const generateResponse = async (message, context, sessionId, searchResults, intentData) => {
  // Build conversation history for Groq (convert 'model' role to 'assistant')
  const conversationHistory = context.history.map(m => ({
    role: m.role === 'model' ? 'assistant' : m.role,
    content: m.content
  }));

  const systemInstruction = `You are Runo, PrimeNest's AI real estate consultant for Nigeria. You are sharp, warm, and genuinely useful — like a knowledgeable friend who knows the Nigerian property market inside out.

IDENTITY RULE (CRITICAL):
- Only introduce yourself by name at the very start of a brand-new session (when intent is "greeting" and there is no conversation history).
- NEVER say "I'm Runo" or "As Runo" or reference your name in any other message. Just talk naturally.

PERSONALITY:
- Direct and confident, but never cold
- Use natural Nigerian-flavored English where it fits (not forced)
- Proactive: anticipate what the user needs next
- Keep replies concise — 2-4 sentences max unless giving detailed advice
- Avoid generic filler phrases like "Great question!" or "Certainly!"

NIGERIAN MARKET KNOWLEDGE — use this to give smart, grounded responses:
- Lagos pricing: Self-con (studio) in Yaba/Surulere: ₦200k–₦600k/yr. 2-bed in Lekki Phase 1: ₦1.5M–₦4M/yr rent. 3-bed for sale in Lekki/VI: ₦80M–₦300M+
- Abuja pricing: 2-bed in Gwarinpa: ₦700k–₦1.5M/yr rent. 3-bed in Maitama/Asokoro for sale: ₦100M–₦500M+
- Port Harcourt: GRA 3-bed: ₦1.5M–₦3M/yr rent
- Neighborhoods: Lekki/VI/Ikoyi = premium Lagos. Surulere/Yaba/Ikeja = mid-range. Ikorodu/Badagry = affordable. Maitama/Asokoro = premium Abuja. Gwarinpa/Kubwa = mid-range Abuja
- Always quote prices in Naira (₦). NEVER mention dollars, pounds, or any other currency.
- Common tradeoffs: Mainland Lagos = cheaper + traffic. Island Lagos = pricier + convenience. Abuja = more orderly, higher land costs.

CURRENT SESSION CONTEXT:
- Previous intent: ${context.lastIntent || 'None'}
- Previous location: ${context.lastLocation || 'None'}
- User preferences so far: ${JSON.stringify(context.preferences)}

CURRENT REQUEST:
- Intent: ${intentData.intent}
- Detected location: ${intentData.location || 'Not specified'}
- Property type: ${intentData.propertyType}
- Listings found: ${searchResults.count}

LISTINGS DATA:
${searchResults.count > 0
      ? searchResults.posts.map((p, i) =>
        `${i + 1}. ${p.title} — ${p.city} | ${p.bedroom} bed, ${p.bathroom} bath | ${p.type === 'rent' ? 'Rent' : 'For sale'} | ₦${p.price?.toLocaleString()}`
      ).join('\n')
      : 'No listings matched the search criteria'}

RESPONSE RULES BY INTENT:

GREETING (first message only): Introduce yourself once, briefly. Ask what they're looking for in a natural, inviting way.

SEARCH with results: Lead with a confident summary ("Found X options in [area]"). Highlight 1–2 standout listings with a quick note on why they're worth looking at. Suggest a next step.

SEARCH with no results: Be direct about it. Offer a smart alternative — nearby area, adjusted price range, or different property type — based on your Nigerian market knowledge.

FOLLOW_UP: Reference the previous search naturally ("Still looking at [location] — here's what else came up..."). Don't re-introduce yourself.

CLARIFICATION: Acknowledge the refinement briefly and show what changed in the results.

ADVICE: Give concrete, Nigeria-specific insights. Mention real neighborhoods, realistic price expectations, and practical tips (e.g. "Always inspect before paying, ask about service charge in estate properties").

SMART RECOMMENDATIONS — always close with ONE genuinely useful next step:
- If they searched an expensive area: suggest a nearby affordable alternative
- If few results: suggest loosening one filter (e.g. bedroom count)
- If lots of results: suggest a filter to narrow down (e.g. price band or specific zone)
- If they seem to be browsing: ask a pointed question to understand their priority (budget? proximity to work? school?)

RESPOND ONLY with this JSON, nothing outside it:
{
  "reply": "Your natural, conversational response",
  "searchUrl": "/list?city=Location" or null,
  "suggestions": ["one short, specific follow-up prompt", "another one"],
  "preferences": {
    "propertyType": "updated type or null",
    "priceRange": {"min": number, "max": number} or null,
    "bedrooms": number or null,
    "locations": ["location1"]
  }
}`;

  try {
    const completion = await retryWithBackoff(
      () => groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: systemInstruction
          },
          ...conversationHistory,
          {
            role: "user",
            content: message
          }
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0.7,
        max_tokens: 800,
        response_format: { type: "json_object" }
      }),
      2,
      1000
    );

    const responseText = completion.choices[0]?.message?.content || '{}';

    try {
      const parsedData = JSON.parse(responseText);

      // Build search URL if applicable
      if (intentData.intent === 'search' && intentData.location) {
        const params = new URLSearchParams();
        params.set('city', intentData.location);
        if (intentData.propertyType && intentData.propertyType !== 'any') {
          params.set('property', intentData.propertyType);
        }
        if (intentData.bedrooms) {
          params.set('bedroom', intentData.bedrooms);
        }
        if (intentData.priceRange) {
          params.set('minPrice', intentData.priceRange.min || 0);
          params.set('maxPrice', intentData.priceRange.max || 10000000);
        }
        parsedData.searchUrl = `/list?${params.toString()}`;
      }

      // Update session with AI-extracted preferences
      if (parsedData.preferences) {
        const session = getSessionContext(sessionId);
        session.preferences = { ...session.preferences, ...parsedData.preferences };
        if (intentData.location && !session.preferences.locations.includes(intentData.location)) {
          session.preferences.locations.push(intentData.location);
        }
      }

      return parsedData;
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr);
      // Try to extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsedData = JSON.parse(jsonMatch[0]);
        if (intentData.intent === 'search' && intentData.location) {
          const params = new URLSearchParams();
          params.set('city', intentData.location);
          parsedData.searchUrl = `/list?${params.toString()}`;
        }
        return parsedData;
      }
      throw new Error("Invalid response format");
    }
  } catch (err) {
    console.error("Response generation error:", err);
    return {
      reply: "I'm having a moment! Let's try that again. What kind of property are you looking for?",
      searchUrl: null,
      suggestions: ["2 bedroom flat in Lekki", "Houses for rent in Abuja", "Apartments under ₦1M in Lagos"]
    };
  }
};

// ============================================
// MAIN CHAT HANDLER
// ============================================

export const chatWithAssistant = async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({
      reply: "Please provide a message.",
      searchUrl: null,
    });
  }

  // Generate or use existing session ID
  const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    // Get or create session context
    const context = getSessionContext(sid);

    // Add user message to history
    context.history.push({ role: 'user', content: message });

    // Step 1: Detect intent with context
    const intentData = await retryWithBackoff(
      () => detectIntent(message, context),
      3,
      500
    );

    console.log(`[${sid}] Intent: ${intentData.intent}, Location: ${intentData.location || 'none'}`);

    // Step 2: Search database if needed
    let searchResults = { count: 0, posts: [] };
    if (['search', 'follow_up', 'clarification'].includes(intentData.intent)) {
      const searchLocation = intentData.location || context.lastLocation;
      if (searchLocation) {
        searchResults = await searchListings({
          location: searchLocation,
          propertyType: intentData.propertyType,
          priceRange: intentData.priceRange,
          bedrooms: intentData.bedrooms,
          action: intentData.action
        });
        console.log(`[${sid}] Found ${searchResults.count} listings`);
      }
    }

    // Step 3: Generate response with full context
    const responseData = await generateResponse(message, context, sid, searchResults, intentData);

    // Add AI response to history
    context.history.push({ role: 'model', content: responseData.reply });

    // Update session context
    updateSessionContext(sid, {
      lastIntent: intentData.intent,
      lastLocation: intentData.location || context.lastLocation
    });

    // Return response with session ID
    res.status(200).json({
      ...responseData,
      sessionId: sid
    });

  } catch (err) {
    console.error("Assistant Error:", err);

    res.status(200).json({
      reply: "I'm having a moment! Let's try that again. What kind of property are you looking for?",
      searchUrl: null,
      sessionId: sid,
      suggestions: ["2 bedroom flat in Lekki", "Houses for rent in Abuja", "Apartments under ₦1M in Lagos"]
    });
  }
};

// ============================================
// SESSION MANAGEMENT ENDPOINTS
// ============================================

export const clearSession = async (req, res) => {
  const { sessionId } = req.body;

  if (sessionId && conversationSessions.has(sessionId)) {
    conversationSessions.delete(sessionId);
  }

  res.status(200).json({
    reply: "Session cleared. How can I help you today?",
    sessionId: null
  });
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
    preferences: session.preferences
  });
};