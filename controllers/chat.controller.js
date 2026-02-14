import prisma from "../lib/prisma.js";

export const getChats = async (req, res) => {
  const tokenUserId = req.userId;

  try {
    const chats = await prisma.chat.findMany({
      where: {
        userIDs: {
          hasSome: [tokenUserId],
        },
      },
    });

    for (const chat of chats) {
      const receiverId = chat.userIDs.find((id) => id !== tokenUserId);

      const receiver = await prisma.user.findUnique({
        where: {
          id: receiverId,
        },
        select: {
          id: true,
          username: true,
          avatar: true,
        },
      });
      chat.receiver = receiver;
    }

    res.status(200).json(chats);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to get chats!" });
  }
};

export const getChat = async (req, res) => {
  const tokenUserId = req.userId;

  try {
    const chat = await prisma.chat.findUnique({
      where: {
        id: req.params.id,
        userIDs: {
          hasSome: [tokenUserId],
        },
      },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    await prisma.chat.update({
      where: {
        id: req.params.id,
      },
      data: {
        seenBy: {
          push: [tokenUserId],
        },
      },
    });
    res.status(200).json(chat);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to get chat!" });
  }
};

export const addChat = async (req, res) => {
  const tokenUserId = req.userId;
  const { receiverId } = req.body;

  // Validate input
  if (!receiverId) {
    return res.status(400).json({ message: "Receiver ID is required!" });
  }

  // Prevent chatting with yourself
  if (tokenUserId === receiverId) {
    return res.status(400).json({ message: "Cannot create chat with yourself!" });
  }

  try {
    // Sort user IDs to ensure consistent ordering (prevents race conditions)
    const sortedUserIds = [tokenUserId, receiverId].sort();
    
    // Check for existing chat with both users
    const existingChat = await prisma.chat.findFirst({
      where: {
        AND: [
          { userIDs: { has: sortedUserIds[0] } },
          { userIDs: { has: sortedUserIds[1] } },
        ],
      },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (existingChat) {
      // Return existing chat instead of creating duplicate
      return res.status(200).json(existingChat);
    }

    // Create new chat with sorted user IDs for consistency
    const newChat = await prisma.chat.create({
      data: {
        userIDs: sortedUserIds,
        seenBy: [tokenUserId], // Creator has seen it
      },
    });
    
    res.status(201).json(newChat);
  } catch (err) {
    console.log(err);
    
    // Handle potential race condition (unique constraint violation)
    if (err.code === 'P2002') {
      // Fetch the chat that was just created by concurrent request
      const existingChat = await prisma.chat.findFirst({
        where: {
          AND: [
            { userIDs: { has: tokenUserId } },
            { userIDs: { has: receiverId } },
          ],
        },
      });
      return res.status(200).json(existingChat);
    }
    
    res.status(500).json({ message: "Failed to create chat!" });
  }
};

export const readChat = async (req, res) => {
  const tokenUserId = req.userId;

  try {
    const chat = await prisma.chat.update({
      where: {
        id: req.params.id,
        userIDs: {
          hasSome: [tokenUserId],
        },
      },
      data: {
        seenBy: {
          set: [tokenUserId],
        },
      },
    });
    res.status(200).json(chat);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to read chat!" });
  }
};