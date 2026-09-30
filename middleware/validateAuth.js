// Request-body validation for the auth routes.
// Runs before the controller so bad input gets a clear 400 instead of
// failing deeper down (e.g. bcrypt throwing on an undefined password).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const reject = (res, errors) =>
  res.status(400).json({ message: "Invalid input", errors });

export const validateRegister = (req, res, next) => {
  const { username, email, password } = req.body ?? {};
  const errors = {};

  if (!isNonEmptyString(username)) {
    errors.username = "Username is required";
  } else if (!USERNAME_RE.test(username.trim())) {
    errors.username =
      "Username must be 3-20 characters: letters, numbers or underscores";
  }

  if (!isNonEmptyString(email)) {
    errors.email = "Email is required";
  } else if (!EMAIL_RE.test(email.trim())) {
    errors.email = "Email is not valid";
  }

  if (typeof password !== "string" || password.length === 0) {
    errors.password = "Password is required";
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }

  if (Object.keys(errors).length) return reject(res, errors);

  req.body.username = username.trim();
  req.body.email = email.trim();
  next();
};

export const validateLogin = (req, res, next) => {
  const { username, password } = req.body ?? {};
  const errors = {};

  if (!isNonEmptyString(username)) errors.username = "Username is required";
  if (typeof password !== "string" || password.length === 0) {
    errors.password = "Password is required";
  }

  if (Object.keys(errors).length) return reject(res, errors);

  req.body.username = username.trim();
  next();
};
