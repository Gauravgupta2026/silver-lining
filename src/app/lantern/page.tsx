import type { Metadata } from "next";
import { LanternStudio } from "@/components/lantern/LanternStudio";

export const metadata: Metadata = { title: "Sun lantern studio — Silver Lining" };

export default function LanternStudioPage() {
  return <LanternStudio />;
}
