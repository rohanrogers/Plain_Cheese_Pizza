import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

export const signJwt = (payload, opts = {}) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES,
    ...opts
  });

export const verifyJwt = (token) =>
  new Promise((resolve, reject) => {
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) reject(err);
      else resolve(decoded);
    });
  });