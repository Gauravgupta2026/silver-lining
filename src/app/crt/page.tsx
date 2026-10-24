import type { Metadata } from "next";
import { CrtStudio } from "@/components/crt/CrtStudio";

export const metadata: Metadata = { title: "CRT studio — Silver Lining" };

export default function CrtStudioPage() {
  return <CrtStudio />;
}
