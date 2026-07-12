import type { AgentRole } from "./types";

export interface DemoSeedFileSpec {
  id: string;
  role: AgentRole;
  profileId: string;
  pdfName: string;
}

/** 预置模拟 PDF 使用固定 ID，便于提交 data/ 后在服务器直接关联资料。 */
export const DEMO_SEED_FILES: DemoSeedFileSpec[] = [
  {
    id: "a1111111-1111-4111-8111-111111110001",
    role: "investor",
    profileId: "investor-demo-001",
    pdfName: "investor_profile_private_cn.pdf",
  },
  {
    id: "a2222222-2222-4222-8222-222222220001",
    role: "founder",
    profileId: "founder-demo-001",
    pdfName: "founder_pitch_private_cn.pdf",
  },
  {
    id: "a2222222-2222-4222-8222-222222220002",
    role: "founder",
    profileId: "founder-demo-001",
    pdfName: "founder_financial_appendix_cn.pdf",
  },
  {
    id: "b1111111-1111-4111-8111-111111110001",
    role: "investor",
    profileId: "investor-demo-002",
    pdfName: "investor_profile_medical_cn.pdf",
  },
  {
    id: "b2222222-2222-4222-8222-222222220001",
    role: "founder",
    profileId: "founder-demo-002",
    pdfName: "founder_pitch_medical_cn.pdf",
  },
  {
    id: "b2222222-2222-4222-8222-222222220002",
    role: "founder",
    profileId: "founder-demo-002",
    pdfName: "founder_financial_appendix_medical_cn.pdf",
  },
];

export function demoSeedFileIdsByProfile(profileId: string): string[] {
  return DEMO_SEED_FILES.filter((file) => file.profileId === profileId).map((file) => file.id);
}
