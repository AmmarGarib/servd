// Minimal root layout — this app is Route Handlers only (no pages), but
// Next.js still requires a root layout for its generated error routes.
export const metadata = { title: 'servd api gateway' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
