import prisma from "../lib/prisma.js";
import jwt from "jsonwebtoken";

// GET ALL POSTS (With Lenient Search)
// GET ALL POSTS (With Lenient Search & Price Fix)
export const getPosts = async (req, res) => {
  const query = req.query;

  try {
    const posts = await prisma.post.findMany({
      where: {
        city: query.city 
          ? { 
              contains: query.city, 
              mode: 'insensitive' 
            } 
          : undefined,
        type: query.type || undefined,
        property: query.property || undefined,
        bedroom: parseInt(query.bedroom) || undefined,
        price: {
          // If minPrice is 0 or missing, start from 0
          gte: parseInt(query.minPrice) || 0,
          // FIX: If maxPrice is 0 or missing, set it to a huge number so it doesn't filter anything
          lte: (parseInt(query.maxPrice) > 0) ? parseInt(query.maxPrice) : 100000000,
        },
      },
    });

    res.status(200).json(posts);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to get posts" });
  }
};

// GET SINGLE POST (With Async Saved Status Check)
export const getPost = async (req, res) => {
  const id = req.params.id;
  try {
    const post = await prisma.post.findUnique({
      where: { id },
      include: {
        postDetail: true,
        user: {
          select: {
            username: true,
            avatar: true,
          },
        },
      },
    });

    if (!post) return res.status(404).json({ message: "Post not found" });

    const token = req.cookies?.token;

    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET_KEY);
        const saved = await prisma.savedPost.findUnique({
          where: {
            userId_postId: {
              postId: id,
              userId: payload.id,
            },
          },
        });
        return res.status(200).json({ ...post, isSaved: !!saved });
      } catch (err) {
        return res.status(200).json({ ...post, isSaved: false });
      }
    }
    
    return res.status(200).json({ ...post, isSaved: false });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to get post" });
  }
};

// ADD POST
export const addPost = async (req, res) => {
  const body = req.body;
  const tokenUserId = req.userId;

  try {
    const newPost = await prisma.post.create({
      data: {
        ...body.postData,
        userId: tokenUserId,
        postDetail: {
          create: body.postDetail,
        },
      },
    });
    res.status(200).json(newPost);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to create post" });
  }
};

// UPDATE POST (Placeholder)
export const updatePost = async (req, res) => {
  try {
    res.status(200).json();
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to update posts" });
  }
};

// DELETE POST (With Relation Cleanup)
export const deletePost = async (req, res) => {
  const id = req.params.id;
  const tokenUserId = req.userId;

  try {
    const post = await prisma.post.findUnique({
      where: { id },
      include: { postDetail: true } 
    });

    if (!post) {
      return res.status(404).json({ message: "Post not found!" });
    }

    if (post.userId !== tokenUserId) {
      return res.status(403).json({ message: "Not Authorized!" });
    }

    // 1. Delete PostDetail first to satisfy DB constraints
    if (post.postDetail) {
      await prisma.postDetail.delete({
        where: { postId: id },
      });
    }

    // 2. Delete SavedPost records
    await prisma.savedPost.deleteMany({
      where: { postId: id },
    });

    // 3. Delete the main Post
    await prisma.post.delete({
      where: { id },
    });

    res.status(200).json({ message: "Post deleted successfully" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to delete post" });
  }
};