import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import prisma from "../lib/prisma.js";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const chatWithAssistant = async (req, res) => {
  const { message } = req.body;

  try {
    // --- 1. RESTORE INTENT DETECTION (The "Smart" part) ---
    const intentCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Categorize the query into one word: 'search', 'advice', or 'greeting'. Also, if it is a 'search', extract the location (e.g. 'Japan') after the word. Example: 'search Japan' or 'greeting none'."
        },
        { role: "user", content: message }
      ],
      model: "llama-3.1-8b-instant", 
      temperature: 0.1,
    });

    const intentRaw = intentCompletion.choices[0]?.message?.content?.toLowerCase() || "greeting none";
    const topIntent = intentRaw.includes("search") ? "search" : (intentRaw.includes("advice") ? "advice" : "greeting");
    
    // Extract location from the intent string
    const location = intentRaw.split(" ").slice(1).join(" ") || "none";

    // --- 2. CHECK DATABASE (Only if searching) ---
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

    // --- 3. GENERATE RESPONSE (Back to your original format) ---
    const systemInstruction = `
      You are "Runo," the global PrimeNest advisor.
      Intent: ${topIntent}
      Database: ${postCount} listings found in ${location}.

      MANDATORY JSON FORMAT:
      {"reply": "...", "searchUrl": "...", "explanation": "..."}

      LOGIC:
      - If greeting/advice: searchUrl is null.
      - If search: 
          - If postCount > 0: "I found ${postCount} houses in ${location}!" searchUrl: "/list?city=${location}"
          - If postCount is 0: "I checked, but we have no listings in ${location} right now." searchUrl: null
    `;

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp", 
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
      res.status(200).json(parsedData);
    } else {
      throw new Error("Formatting Error");
    }

  } catch (err) {
    console.error("Assistant Error:", err);
    res.status(200).json({
      reply: "Hi! I'm Runo. How can I help you today?",
      searchUrl: null,
      explanation: "Safe fallback."
    });
  }
};