import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const chatWithAssistant = async (req, res) => {
  const { message } = req.body;

  try {
    // --- PART 1: INTENT DETECTION (GROQ) ---
    const intentCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Categorize the user's real estate query into exactly one word: 'search', 'advice', or 'greeting'."
        },
        { role: "user", content: message }
      ],
      model: "llama-3.1-8b-instant", 
      temperature: 0.1,
    });

    const topIntent = intentCompletion.choices[0]?.message?.content?.toLowerCase() || "greeting";
    console.log("Detected Intent via Groq:", topIntent);

    // --- PART 2: UPDATED SYSTEM INSTRUCTIONS ---
    const systemInstruction = `
      You are "Runo," the official AI for PrimeNest Real Estate. 
      Current Intent: ${topIntent} 
      
      MANDATORY RESPONSE FORMAT:
      You must ALWAYS return a JSON object. No prose outside the JSON.
      Structure: {"reply": "...", "searchUrl": "...", "explanation": "..."}

      LOGIC RULES:
      1. If Intent is 'greeting' or 'advice': Set "searchUrl" to null.
      2. If Intent is 'search': Generate a "searchUrl" starting with "/list".
      
      URL PARAMETERS:
      - Extract city: city=CityName
      - Extract bedrooms: bedroom=X (Crucial: '1 bedroom' = 1, '2 bedrooms' = 2)
      - Extract type: type=buy or rent
      
      Example Search: {"reply": "Searching for 2-bed houses.", "searchUrl": "/list?city=london&bedroom=2", "explanation": "Filtered by bedroom count."}
      Example Greeting: {"reply": "Hello! How can I help?", "searchUrl": null, "explanation": "Greeting detected."}
    `;

    // --- PART 3: GENERATION (USING YOUR ORIGINAL MODELS/SYNTAX) ---
    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: message,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.7, // Lowered slightly for more consistent JSON
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: "minimal"
        },
      },
    });

    const responseText = result.text;
    
    // Clean potential markdown and find JSON
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsedData = JSON.parse(jsonMatch[0]);
      
      // DOUBLE CHECK: If it's just a greeting, force searchUrl to null
      if (topIntent === "greeting") {
        parsedData.searchUrl = null;
      }

      res.status(200).json(parsedData);
    } else {
      throw new Error("Formatting Error");
    }

  } catch (err) {
    console.error("Assistant Error:", err);
    // Safe Fallback so the frontend never breaks
    res.status(200).json({
      reply: "Hi! I'm Runo. I'm ready to help you navigate the property market. What are you looking for?",
      searchUrl: null,
      explanation: "Safe fallback triggered."
    });
  }
};