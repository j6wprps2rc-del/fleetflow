import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Protect everything except Next internals, static assets, health check and login.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/health|login|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'
  ]
};
