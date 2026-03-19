import prisma from "../lib/prisma.js";

export const getUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        posts: true,
      },
    });
    res.status(200).json(users);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to get users!" });
  }
};

export const delistHouse = async (req, res) => {
  const { id } = req.params;
  const { adminEmail } = req.body;

  try {
    const updatedPost = await prisma.post.update({
      where: { id },
      data: {
        status: "delisted",
        delistedBy: adminEmail,
      },
    });
    res.status(200).json(updatedPost);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to delist house!" });
  }
};

export const banUser = async (req, res) => {
  const { id } = req.params;

  try {
    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isBanned: true,
      },
    });
    res.status(200).json(updatedUser);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to ban user!" });
  }
};
