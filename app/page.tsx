import type { Metadata } from "next";
import DemoApp from "./DemoApp";

export const metadata: Metadata = {
  title: "创投社区数字分身对话调试器",
  description: "通过分层提示词调试投资人与创业者数字分身的投融资初筛对话，并生成结构化结果与记忆。",
};

export default function Home() {
  return <DemoApp />;
}
