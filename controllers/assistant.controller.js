import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import prisma from "../lib/prisma.js";

dotenv.config();

// Reverting to your exact initialization style
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const chatWithAssistant = async (req, res) => {
  const { message } = req.body;

  try {
    // 1. EXTRACT LOCATION (Groq)
    const extraction = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "Extract city or country. Return ONLY the name. If none, return 'none'." },
        { role: "user", content: message }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
    });

    const location = extraction.choices[0]?.message?.content?.trim() || "none";

    // 2. CHECK DATABASE
    let postCount = 0;
    if (location.toLowerCase() !== "none") {
      const posts = await prisma.post.findMany({
        where: {
          OR: [
            { city: { contains: location, mode: 'insensitive' } },
            { country: { contains: location, mode: 'insensitive' } }
          ]
        }
      });
      postCount = posts.length;
    }

    // 3. GENERATE CONTENT (Using your ORIGINAL model syntax)
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash", // Using the correct version for this SDK
      contents: message,
      config: {
        systemInstruction: `
          You are "Runo," the official AI for PrimeNest. 
          DATABASE STATUS: Found ${postCount} houses in ${location}.
          
          MANDATORY FORMAT: Return ONLY a JSON object.
          {"reply": "...", "searchUrl": "...", "explanation": "..."}

          LOGIC:
          - If postCount is 0, say you found nothing in ${location}.
          - If postCount > 0, provide the link.
        `,
      },
    });

    // Extracting the text like you did before
    const responseText = result.text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsedData = JSON.parse(jsonMatch[0]);
      if (postCount > 0 && location !== "none") {
        parsedData.searchUrl = `/list?city=${location}`;
      } else if (postCount === 0) {
        parsedData.searchUrl = null;
      }
      res.status(200).json(parsedData);
    } else {
      throw new Error("JSON Parse Error");
    }

  } catch (err) {
    console.error("Assistant Error:", err);
    res.status(200).json({
      reply: "I'm having a connection issue. Please try again!",
      searchUrl: null
    });
  }
};