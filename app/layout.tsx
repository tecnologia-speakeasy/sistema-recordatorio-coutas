import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import "./globals.css";

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Recordatorios de cuotas · Speak Easy",
  description: "Panel de envíos de recordatorios de pago por WhatsApp",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`${montserrat.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <header className="bg-morado text-white">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
            <Link href="/" className="flex items-center gap-3 rounded-lg">
              <Image src="/marca/logo.webp" alt="Speak Easy" width={94} height={48} priority />
              <span className="hidden border-l border-white/30 pl-3 text-sm font-semibold sm:block">
                Recordatorios de cuotas
              </span>
            </Link>
          </div>
        </header>
        <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">{children}</div>
      </body>
    </html>
  );
}
