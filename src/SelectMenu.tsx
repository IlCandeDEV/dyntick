import type { ComponentProps } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { Icon, type IconName } from "./Icons.tsx";

const supportsAnchoredPopover = typeof HTMLElement !== "undefined" &&
  typeof HTMLElement.prototype.showPopover === "function" && typeof CSS !== "undefined" &&
  CSS.supports("anchor-name", "--select-trigger") && CSS.supports("position-area", "bottom") &&
  CSS.supports("position-try-fallbacks", "flip-block");

type NonClearableSelectorProps = Extract<ComponentProps<typeof Selector>, { hasClear?: false }>;

type SelectMenuProps = Pick<NonClearableSelectorProps,
  "label" | "isLabelHidden" | "value" | "options" | "onChange" | "isDisabled" | "renderValue"
> & {
  icon: IconName;
  className?: string;
  "data-testid"?: string;
  "data-language"?: string;
};

export function SelectMenu({ icon, className, isLabelHidden = true, ...props }: SelectMenuProps) {
  return <Selector {...props} hasClear={false} isLabelHidden={isLabelHidden}
    variant="secondary" size="sm" presentation={supportsAnchoredPopover ? "adaptive" : "bottom-sheet"} placement="below"
    startIcon={<Icon name={icon} width="17" height="17" />}
    containerClassName={className ? `select-menu ${className}` : "select-menu"} controlClassName="select-trigger" />;
}
