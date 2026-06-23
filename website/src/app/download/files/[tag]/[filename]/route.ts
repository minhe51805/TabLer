import { NextResponse } from "next/server";

const releaseBase =
  "https://github.com/minhe51805/TabLer/releases/download";
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const filenamePattern = /^TableR[A-Za-z0-9._-]{1,179}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ tag: string; filename: string }> },
) {
  const { tag, filename } = await context.params;

  if (!tagPattern.test(tag) || !filenamePattern.test(filename)) {
    return NextResponse.json(
      { error: "Download file not found." },
      { status: 404 },
    );
  }

  const target = `${releaseBase}/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
  return NextResponse.redirect(target, 307);
}
