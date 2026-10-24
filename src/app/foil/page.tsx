import type { Metadata } from "next";
import { FoilStudio } from "@/components/foil/FoilStudio";

export const metadata: Metadata = { title: "Foil studio — Silver Lining" };

export default function FoilStudioPage() {
  return <FoilStudio />;
}
