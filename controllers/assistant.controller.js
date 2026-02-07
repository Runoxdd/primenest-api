import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import prisma from "../lib/prisma.js"; // Added back for the search check

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const chatWithAssistant = async (req, res) => {
  const { message } = req.body;

  try {
    // --- PART 1: INTENT DETECTION (GROQ) ---
    // Added a small instruction to extract the location name if searching
    const intentCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Categorize the user's real estate query into exactly one word: 'search', 'advice', or 'greeting'. If 'search', identify the city or country mentioned. Format your response as 'intent|location' (e.g., 'search|Japan' or 'greeting|none')."
        },
        { role: "user", content: message }
      ],
      model: "llama-3.1-8b-instant", 
      temperature: 0.1,
    });

    const intentRaw = intentCompletion.choices[0]?.message?.content?.toLowerCase() || "greeting|none";
    const [topIntent, location] = intentRaw.split("|").map(s => s.trim());
    
    console.log("Detected Intent:", topIntent, "Location:", location);

    // --- NEW: DATABASE CHECK (MINIMAL TWEAK) ---
    let postCount = 0;
    if (topIntent === "search" && location !== "none") {
      const posts = await prisma.post.findMany({
        where: {
          OR: [
            { city: { contains: location, mode: 'insensitive' } },
            { country: { contains: location, mode: 'insensitive' } },
            { address: { contains: location, mode: 'insensitive' } }
          ]
        }
      });
      postCount = posts.length;
    }

    // --- PART 2: UPDATED SYSTEM INSTRUCTIONS (YOUR ORIGINAL STYLE) ---
    const systemInstruction = `
      You are "Runo," the official AI for PrimeNest Real Estate. 
      Current Intent: ${topIntent} 
      Database Count: ${postCount} listings found in ${location}.
      
      MANDATORY RESPONSE FORMAT:
      You must ALWAYS return a JSON object. No prose outside the JSON.
      Structure: {"reply": "...", "searchUrl": "...", "explanation": "..."}

      LOGIC RULES:
      1. If Intent is 'greeting' or 'advice': Set "searchUrl" to null.
      2. If Intent is 'search':
         - If Database Count > 0: Generate a "searchUrl" like "/list?city=${location}".
         - If Database Count is 0: Tell the user we don't have listings in ${location} yet, and set "searchUrl" to null.
      
      URL PARAMETERS:
      - Extract city: city=CityName
      - Extract bedrooms: bedroom=X 
      - Extract type: type=buy or rent
    `;

    // --- PART 3: GENERATION (YOUR ORIGINAL SYNTAX) ---
    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview", // Using stable version to avoid the 404
      contents: message,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.7,
      },
    });

    const responseText = result.text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsedData = JSON.parse(jsonMatch[0]);
      
      // Safety: ensure greetings never have URLs
      if (topIntent === "greeting") {
        parsedData.searchUrl = null;
      }

      res.status(200).json(parsedData);
    } else {
      throw new Error("Formatting Error");
    }

  } catch (err) {
    console.error("Assistant Error:", err);
    res.status(200).json({
      reply: "Hi! I'm Runo. I'm ready to help you navigate the property market. What are you looking for?",
      searchUrl: null,
      explanation: "Safe fallback triggered."
    });
  }
};