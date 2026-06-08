#pragma once

#if defined(__clang__) && defined(__cplusplus)
#include <iterator>
namespace stdext {
    template <typename T>
    class checked_array_iterator {
    private:
        T ptr_;
    public:
        using value_type = typename std::iterator_traits<T>::value_type;
        using difference_type = typename std::iterator_traits<T>::difference_type;
        using pointer = T;
        using reference = typename std::iterator_traits<T>::reference;
        using iterator_category = typename std::iterator_traits<T>::iterator_category;

        checked_array_iterator() : ptr_(nullptr) {}
        checked_array_iterator(T p, size_t) : ptr_(p) {}
        checked_array_iterator(T p, size_t, size_t) : ptr_(p) {}

        operator T() const { return ptr_; }

        reference operator*() const { return *ptr_; }
        T operator->() const { return ptr_; }
        reference operator[](ptrdiff_t index) const { return ptr_[index]; }

        checked_array_iterator& operator++() {
            ++ptr_;
            return *this;
        }
        checked_array_iterator operator++(int) {
            checked_array_iterator tmp = *this;
            ++ptr_;
            return tmp;
        }
        checked_array_iterator& operator--() {
            --ptr_;
            return *this;
        }
        checked_array_iterator operator--(int) {
            checked_array_iterator tmp = *this;
            --ptr_;
            return tmp;
        }
        checked_array_iterator& operator+=(ptrdiff_t n) {
            ptr_ += n;
            return *this;
        }
        checked_array_iterator& operator-=(ptrdiff_t n) {
            ptr_ -= n;
            return *this;
        }
        friend checked_array_iterator operator+(checked_array_iterator it, ptrdiff_t n) {
            it += n;
            return it;
        }
        friend checked_array_iterator operator+(ptrdiff_t n, checked_array_iterator it) {
            it += n;
            return it;
        }
        friend checked_array_iterator operator-(checked_array_iterator it, ptrdiff_t n) {
            it -= n;
            return it;
        }
        friend ptrdiff_t operator-(const checked_array_iterator& lhs, const checked_array_iterator& rhs) {
            return lhs.ptr_ - rhs.ptr_;
        }
        bool operator==(const checked_array_iterator& other) const { return ptr_ == other.ptr_; }
        bool operator!=(const checked_array_iterator& other) const { return ptr_ != other.ptr_; }
        bool operator<(const checked_array_iterator& other) const { return ptr_ < other.ptr_; }
        bool operator>(const checked_array_iterator& other) const { return ptr_ > other.ptr_; }
        bool operator<=(const checked_array_iterator& other) const { return ptr_ <= other.ptr_; }
        bool operator>=(const checked_array_iterator& other) const { return ptr_ >= other.ptr_; }
    };
}
#endif
