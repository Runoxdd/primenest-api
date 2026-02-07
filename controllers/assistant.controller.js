import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import prisma from "../lib/prisma.js";

dotenv.config();

const ai = new GoogleGenAI(process.env.GEMINI_API_KEY); // Simplified init
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const chatWithAssistant = async (req, res) => {
  const { message } = req.body;

  try {
    // 1. EXTRACT LOCATION
    const extraction = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Extract the location. Return ONLY the location name. If none, return 'none'."
        },
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
            { country: { contains: location, mode: 'insensitive' } },
            { address: { contains: location, mode: 'insensitive' } }
          ]
        }
      });
      postCount = posts.length;
    }

    // 3. GENERATE RESPONSE
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const systemInstruction = `
      You are "Runo," the official AI for PrimeNest. 
      CURRENT DATABASE STATUS: Found ${postCount} houses in ${location}.
      
      RULES:
      1. If post count is 0, say: "I checked our database, but there are no houses in ${location} right now."
      2. If post count > 0, say: "I found ${postCount} listings in ${location}!"
      3. Format as JSON: {"reply": "...", "searchUrl": "...", "explanation": "..."}
      4. If post count is 0, set searchUrl to null.
    `;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: { responseMimeType: "application/json" },
      systemInstruction: systemInstruction,
    });

    const parsedData = JSON.parse(result.response.text());

    if (postCount > 0 && location !== "none") {
      parsedData.searchUrl = `/list?city=${location}`;
    }

    res.status(200).json(parsedData);

  } catch (err) {
    console.error("Assistant Error:", err);
    res.status(200).json({
      reply: "Runo's data stream is interrupted. Please try again.",
      searchUrl: null,
      explanation: "Fallback triggered."
    });
  }
};