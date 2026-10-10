import { Link, useRouterState } from "@tanstack/react-router";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";

export function AuthSlot({ onNavigate }: { onNavigate?: () => void }) {
  const { user, isPending } = useCurrentUserState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (isPending) {
    return <div className="h-10 w-28 shrink-0 animate-pulse rounded-md bg-surface-2" />;
  }

  if (user) {
    return (
      <div className="user-chip flex items-center gap-3">
        {pathname !== "/court" ? (
          <Button asChild size="sm">
            <Link to="/court" onClick={onNavigate}>
              Inner court
            </Link>
          </Button>
        ) : null}
        <UserButton />
      </div>
    );
  }

  return (
    <Button asChild size="sm">
      <Link to="/login" onClick={onNavigate}>
        Member login
      </Link>
    </Button>
  );
}
