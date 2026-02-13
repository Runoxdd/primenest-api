import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import prisma from "../lib/prisma.js";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Retry utility function
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

// Intent detection with improved parsing
const detectIntent = async (message) => {
  const intentCompletion = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content: `Categorize the user's real estate query. Respond in this EXACT format: "intent|location"
        
Examples:
- "houses in Japan" → "search|Japan"
- "apartments for rent in Lagos" → "search|Lagos"
- "I want to buy property in London" → "search|London"
- "hello" → "greeting|none"
- "how are you" → "greeting|none"
- "what's the best area to invest" → "advice|none"
- "tips for first time buyers" → "advice|none"

Rules:
- Intent must be exactly: search, advice, or greeting
- Location is the city/country mentioned, or "none" if not applicable
- Be consistent with the format`
      },
      { role: "user", content: message }
    ],
    model: "llama-3.1-8b-instant",
    temperature: 0.1,
  });

  const rawResponse = intentCompletion.choices[0]?.message?.content?.toLowerCase() || "greeting|none";
  
  // Parse with multiple fallback patterns
  const patterns = [
    /^(\w+)\|(.+)$/,           // Standard format: intent|location
    /^(\w+)\s*[\:\-]\s*(.+)$/, // Alternative: intent: location or intent - location
    /^(\w+)\s+in\s+(.+)$/,     // Natural: search in Japan
  ];

  for (const pattern of patterns) {
    const match = rawResponse.match(pattern);
    if (match) {
      const intent = match[1].trim();
      const location = match[2].trim();
      
      // Validate intent
      if (['search', 'advice', 'greeting'].includes(intent)) {
        return { intent, location: location === 'none' ? null : location };
      }
    }
  }

  // Fallback: check for keywords in the original message
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('house') || lowerMessage.includes('apartment') || 
      lowerMessage.includes('property') || lowerMessage.includes('rent') ||
      lowerMessage.includes('buy') || lowerMessage.includes('find')) {
    // Try to extract location from message
    const locationMatch = lowerMessage.match(/(?:in|at|near)\s+([a-zA-Z\s]+)/);
    return { 
      intent: 'search', 
      location: locationMatch ? locationMatch[1].trim() : null 
    };
  }

  return { intent: 'greeting', location: null };
};

// Database query with connection warming
const searchListings = async (location) => {
  if (!location) return { count: 0, posts: [] };

  try {
    // Ensure connection is active
    await prisma.$connect();
    
    const posts = await prisma.post.findMany({
      where: {
        OR: [
          { city: { contains: location, mode: 'insensitive' } },
          { country: { contains: location, mode: 'insensitive' } },
          { address: { contains: location, mode: 'insensitive' } }
        ]
      },
      select: { id: true, title: true, city: true, country: true }
    });

    return { count: posts.length, posts };
  } catch (err) {
    console.error("Database query error:", err);
    return { count: 0, posts: [] };
  }
};

export const chatWithAssistant = async (req, res) => {
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({
      reply: "Please provide a message.",
      searchUrl: null,
    });
  }

  try {
    // Step 1: Detect intent with retry
    const { intent, location } = await retryWithBackoff(
      () => detectIntent(message),
      3,
      500
    );
    
    console.log(`Intent: ${intent}, Location: ${location || 'none'}`);

    // Step 2: Search database if needed
    let searchResults = { count: 0, posts: [] };
    if (intent === 'search' && location) {
      searchResults = await searchListings(location);
      console.log(`Found ${searchResults.count} listings in ${location}`);
    }

    // Step 3: Generate response
    const systemInstruction = `
      You are "Runo," the official AI assistant for PrimeNest Real Estate.
      
      Current Context:
      - User Intent: ${intent}
      - Location Mentioned: ${location || 'Not specified'}
      - Listings Found: ${searchResults.count}
      
      RESPONSE FORMAT (JSON only, no other text):
      {
        "reply": "Your helpful response to the user",
        "searchUrl": "/list?city=LocationName" or null,
        "suggestions": ["suggestion1", "suggestion2"] (optional)
      }
      
      RULES:
      1. If intent is 'greeting': Be friendly, introduce yourself, ask how you can help. Set searchUrl to null.
      2. If intent is 'advice': Provide helpful real estate advice. Set searchUrl to null.
      3. If intent is 'search':
         - If listings found > 0: Confirm you found listings and provide searchUrl
         - If listings found = 0: Apologize that no listings were found in that location, suggest alternatives
         - searchUrl format: "/list?city=${encodeURIComponent(location || '')}"
      
      TONE: Professional, helpful, concise. Keep responses under 100 words.
    `;

    const result = await retryWithBackoff(
      () => ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: message,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7,
          maxOutputTokens: 500,
        },
      }),
      2,
      1000
    );

    const responseText = result.text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsedData = JSON.parse(jsonMatch[0]);
      
      // Safety checks
      if (intent === 'greeting' || intent === 'advice') {
        parsedData.searchUrl = null;
      }
      
      // Ensure searchUrl is properly formatted
      if (parsedData.searchUrl && location) {
        parsedData.searchUrl = `/list?city=${encodeURIComponent(location)}`;
      }

      res.status(200).json(parsedData);
    } else {
      throw new Error("Invalid response format");
    }

  } catch (err) {
    console.error("Assistant Error:", err);
    
    // Graceful fallback
    res.status(200).json({
      reply: "I'm here to help you find your perfect property! You can ask me about listings in any city, get real estate advice, or search for specific property types. What would you like to know?",
      searchUrl: null,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};
