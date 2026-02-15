import prisma from "../lib/prisma.js";
import jwt from "jsonwebtoken";
import axios from "axios"; // Ensure axios is installed in your backend

// GET ALL POSTS (With Improved "AI" Search)
export const getPosts = async (req, res) => {
  const query = req.query;

  try {
    const posts = await prisma.post.findMany({
      where: {
        // This OR logic allows searching "USA" to find posts in Springfield, USA
        OR: query.city ? [
          { city: { contains: query.city, mode: 'insensitive' } },
          { country: { contains: query.city, mode: 'insensitive' } },
          { address: { contains: query.city, mode: 'insensitive' } }
        ] : undefined,
        type: query.type || undefined,
        property: query.property || undefined,
        bedroom: parseInt(query.bedroom) || undefined,
        price: {
          gte: parseInt(query.minPrice) || 0,
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

// GET SINGLE POST
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

// ADD POST (With Automatic Country Detection)
export const addPost = async (req, res) => {
  const body = req.body;
  const tokenUserId = req.userId;

  try {
    const { latitude, longitude } = body.postData;
    let country = "";

    // Automatic Country Lookup via Latitude/Longitude
    try {
      const geoRes = await axios.get(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`,
        { headers: { "User-Agent": "PrimeNest-App" } }
      );
      country = geoRes.data.address.country || "";
    } catch (geoErr) {
      console.log("Geocoding failed, creating post without country info.");
    }

    const newPost = await prisma.post.create({
      data: {
        ...body.postData,
        currency: body.postData.currency || "USD", // Default to USD if not provided
        country: country, // Storing the detected country
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

// UPDATE POST
export const updatePost = async (req, res) => {
  const id = req.params.id;
  const tokenUserId = req.userId;
  const body = req.body;

  try {
    // 1. Check if post exists and user is authorized
    const existingPost = await prisma.post.findUnique({
      where: { id },
      include: { postDetail: true }
    });

    if (!existingPost) {
      return res.status(404).json({ message: "Post not found!" });
    }

    if (existingPost.userId !== tokenUserId) {
      return res.status(403).json({ message: "Not Authorized!" });
    }

    // 2. Update the post with postDetail
    const updatedPost = await prisma.post.update({
      where: { id },
      data: {
        title: body.postData.title,
        price: parseInt(body.postData.price),
        currency: body.postData.currency || existingPost.currency,
        address: body.postData.address,
        city: body.postData.city,
        bedroom: parseInt(body.postData.bedroom),
        bathroom: parseInt(body.postData.bathroom),
        type: body.postData.type,
        property: body.postData.property,
        latitude: body.postData.latitude,
        longitude: body.postData.longitude,
        images: body.postData.images || existingPost.images,
        postDetail: {
          upsert: {
            create: body.postDetail,
            update: body.postDetail,
          },
        },
      },
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

    res.status(200).json(updatedPost);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to update post" });
  }
};

// DELETE POST
export const deletePost = async (req, res) => {
  const id = req.params.id;
  const tokenUserId = req.userId;

  try {
    const post = await prisma.post.findUnique({
      where: { id },
      include: { postDetail: true } 
    });

    if (!post) return res.status(404).json({ message: "Post not found!" });
    if (post.userId !== tokenUserId) return res.status(403).json({ message: "Not Authorized!" });

    if (post.postDetail) {
      await prisma.postDetail.delete({ where: { postId: id } });
    }
    await prisma.savedPost.deleteMany({ where: { postId: id } });
    await prisma.post.delete({ where: { id } });

    res.status(200).json({ message: "Post deleted successfully" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to delete post" });
  }
};