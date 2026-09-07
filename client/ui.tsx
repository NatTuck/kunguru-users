import type { ReactNode } from "react";
import { Chip, Modal } from "@heroui/react";

/** Controlled HeroUI v3 modal shell. Render only when `open`; parent unmounts on close. */
export function ModalShell({
  open,
  onClose,
  title,
  children,
  footer,
  width,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Container>
        <Modal.Dialog className={width ?? "sm:max-w-[520px]"}>
          <Modal.CloseTrigger />
          {title && (
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
          )}
          <Modal.Body>{children}</Modal.Body>
          {footer && <Modal.Footer>{footer}</Modal.Footer>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

const CHIP_COLORS: Record<string, "success" | "warning" | "danger" | "accent"> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  accent: "accent",
};

export function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "warning" | "danger" | "accent" | "neutral";
}) {
  if (tone === "neutral") {
    return <Chip>{label}</Chip>;
  }
  return <Chip color={CHIP_COLORS[tone]}>{label}</Chip>;
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-sm break-all">
      {children}
    </span>
  );
}
