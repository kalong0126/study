/**
 * 课文接口（孩子端只读）
 */
import { Router } from "express";
import { listLessons } from "../db/repo/lessons.js";
import { ah, ok } from "./helpers.js";

export const lessonsRouter = Router();

lessonsRouter.get(
  "/lessons",
  ah(async (_req, res) => {
    const lessons = await listLessons(true);
    ok(res, {
      lessons: lessons.map((l) => ({
        id: l.id,
        title: l.title,
        unit: l.unit,
        note: l.note,
        content: l.content,
        sortNo: l.sortNo,
        chars: l.chars.filter((c) => !c.hidden),
      })),
    });
  }),
);
