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
        content: `Analyze the user's real estate query with conversation context.
        
${contextHint}

Categorize the query and extract information. Respond in this EXACT JSON format:
{
  "intent": "search|advice|greeting|follow_up|clarification",
  "location": "city/country name or null",
  "propertyType": "apartment|house|condo|land|any",
  "priceRange": {"min": number, "max": number} or null,
  "bedrooms": number or null,
  "action": "buy|rent|any"
}

Intent Types:
- search: User wants to find properties
- advice: User wants real estate advice/tips
- greeting: User is saying hello/starting conversation
- follow_up: User is asking about previous results
- clarification: User is refining their search

Examples:
- "houses in Japan" → {"intent":"search","location":"Japan","propertyType":"house",...}
- "apartments for rent in Lagos under 5 million" → {"intent":"search","location":"Lagos","propertyType":"apartment","priceRange":{"min":0,"max":5000000},"action":"rent"}
- "show me more" → {"intent":"follow_up",...}
- "what about 2 bedrooms?" → {"intent":"clarification","bedrooms":2,...}
- "hello" → {"intent":"greeting",...}`
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
  
  const systemInstruction = `You are "Runo," PrimeNest's expert AI real estate consultant. You are the pride and joy of the website - professional, knowledgeable, and genuinely helpful.

PERSONALITY:
- Warm and approachable, like a knowledgeable friend
- Expert in real estate markets, trends, and advice
- Proactive in understanding user needs
- Remember conversation context and build on it
- Concise but thorough (aim for 2-3 sentences unless more detail is needed)

CURRENT CONTEXT:
- Session ID: ${sessionId}
- Previous Intent: ${context.lastIntent || 'None'}
- Previous Location: ${context.lastLocation || 'None'}
- User Preferences: ${JSON.stringify(context.preferences)}
- Current Intent: ${intentData.intent}
- Detected Location: ${intentData.location || 'Not specified'}
- Property Type: ${intentData.propertyType}
- Search Results Found: ${searchResults.count}

SEARCH RESULTS:
${searchResults.count > 0 ? 
  searchResults.posts.map((p, i) => `${i + 1}. ${p.title} - ${p.city}, ${p.country} (${p.bedroom} bed, ${p.bathroom} bath) - ${p.type === 'rent' ? 'Rent' : 'Sale'}`).join('\n') 
  : 'No listings found matching criteria'}

RESPONSE GUIDELINES:

1. GREETING: Be warm and inviting. Introduce yourself briefly and ask how you can help.

2. ADVICE: Share helpful real estate insights. Be specific and actionable.

3. SEARCH with results: Celebrate finding options! Mention the count and highlight 1-2 interesting properties.

4. SEARCH without results: Be empathetic. Suggest alternatives or ask clarifying questions.

5. FOLLOW_UP: Reference previous conversation naturally. "Looking at those ${context.lastLocation} properties again..."

6. CLARIFICATION: Acknowledge the refinement and show updated results.

Always end with a helpful follow-up question or suggestion to keep the conversation flowing naturally.

IMPORTANT: You must respond ONLY with valid JSON in this exact format, no other text:
{
  "reply": "Your conversational response",
  "searchUrl": "/list?city=Location" or null,
  "suggestions": ["suggestion 1", "suggestion 2"],
  "preferences": {
    "propertyType": "updated type or null",
    "priceRange": {"min": number, "max": number} or null,
    "bedrooms": number or null,
    "locations": ["location1", "location2"]
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
      reply: "I'm here to help you find your perfect property! Could you tell me more about what you're looking for?",
      searchUrl: null,
      suggestions: ["Show me apartments in Lagos", "Find houses under ₦5M", "2 bedroom flats for rent"]
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
      suggestions: ["Apartments in Lagos", "Houses for rent", "Properties under ₦5M"]
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
