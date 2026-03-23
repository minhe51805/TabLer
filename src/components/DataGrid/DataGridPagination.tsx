import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface DataGridPaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function DataGridPagination({ currentPage, totalPages, onPageChange }: DataGridPaginationProps) {
  return (
    <div className="datagrid-pagination">
      <button
        onClick={() => onPageChange(0)}
        disabled={currentPage === 0}
        className="datagrid-page-btn"
      >
        <ChevronsLeft className="!w-3.5 !h-3.5" />
      </button>
      <button
        onClick={() => onPageChange(Math.max(0, currentPage - 1))}
        disabled={currentPage === 0}
        className="datagrid-page-btn"
      >
        <ChevronLeft className="!w-3.5 !h-3.5" />
      </button>
      <span className="datagrid-page-status">
        {currentPage + 1} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(Math.min(totalPages - 1, currentPage + 1))}
        disabled={currentPage >= totalPages - 1}
        className="datagrid-page-btn"
      >
        <ChevronRight className="!w-3.5 !h-3.5" />
      </button>
      <button
        onClick={() => onPageChange(totalPages - 1)}
        disabled={currentPage >= totalPages - 1}
        className="datagrid-page-btn"
      >
        <ChevronsRight className="!w-3.5 !h-3.5" />
      </button>
    </div>
  );
}
