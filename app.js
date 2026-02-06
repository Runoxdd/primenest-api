import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoute from "./routes/auth.route.js";
import postRoute from "./routes/post.route.js";
import testRoute from "./routes/test.route.js";
import userRoute from "./routes/user.route.js";
import chatRoute from "./routes/chat.route.js";
import messageRoute from "./routes/message.route.js";
import assistantRoute from "./routes/assistant.route.js";

const app = express();

// We allow BOTH localhost (for you) and the future Vercel URL (for the world)
const allowedOrigins = [process.env.CLIENT_URL, "http://localhost:5173"];

app.use(cors({ 
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }, 
  credentials: true 
}));

app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRoute);
app.use("/api/users", userRoute);
app.use("/api/posts", postRoute);
app.use("/api/test", testRoute);
app.use("/api/chats", chatRoute);
app.use("/api/messages", messageRoute);
app.use("/api/assistant", assistantRoute);

// Render will provide a PORT environment variable. If not, use 8800.
const PORT = process.env.PORT || 8800;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}!`);
});