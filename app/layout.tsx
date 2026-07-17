export const metadata = {
  title: "Trilly's Track",
  description: "Saratoga handicapping desk",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
